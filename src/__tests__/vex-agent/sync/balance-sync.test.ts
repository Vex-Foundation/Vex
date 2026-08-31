import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ───────────────────────────────────────────────────────
// `listWallets` drives which wallets the background sync projects (puzzle 5
// phase 5E-1 - sync iterates the whole inventory, NOT just the primary).
const mockListWallets = vi.fn();
vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (family: string) => mockListWallets(family),
}));

// Direct mock of the Khalani balance scan (balance-sync calls this).
const mockScan = vi.fn();
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: unknown[]) => mockScan(...args),
}));

// Khalani dynamic registry - drives the Khalani-first partition in
// syncWalletBalances (and resolveChainHint via sync/chains.js). Default fixture
// below does NOT contain 4663, so 4663 routes to the local path.
const mockGetCachedKhalaniChains = vi.fn();
const mockResolveChainId = vi.fn();
vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: () => mockGetCachedKhalaniChains(),
  resolveChainId: (...a: unknown[]) => mockResolveChainId(...a),
}));

// Local (non-Khalani) direct-RPC sync is exercised by its own suite. Here it is
// mocked to a no-op so these Khalani-focused tests stay hermetic (no real RPC)
// and prove the Khalani path is unchanged when a local chain is also in scope.
const mockLocalSync = vi.fn();
vi.mock("../../../vex-agent/sync/local-chain-balance-sync.js", () => ({
  syncLocalChainForWallet: (...args: unknown[]) => mockLocalSync(...args),
}));

// Pendle enrichment is its own suite (balance-sync-pendle + merge). Here both the
// merge and the standalone seed are no-ops so these Khalani-focused tests stay
// hermetic (the real enrichment reads proj_activity + Pendle RPC/API): the merge
// passes the rows through, the seed reports "skipped" so it writes nothing.
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
const mockInsertSnapshot = vi.fn();
const mockGetLatestSnapshot = vi.fn().mockResolvedValue(null);

vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...a: unknown[]) => mockReplaceBalances(...a),
  getBalances: (...a: unknown[]) => mockGetBalances(...a),
  getBalancesByChain: (...a: unknown[]) => mockGetBalancesByChain(...a),
  insertSnapshot: (...a: unknown[]) => mockInsertSnapshot(...a),
  getLatestSnapshot: (...a: unknown[]) => mockGetLatestSnapshot(...a),
  getSnapshotHistory: vi.fn().mockResolvedValue([]),
}));

// Wave P: `fullBalanceSync` consults the group-wide pending predicate before it
// may snapshot. Default is "nothing pending" so every pre-existing case keeps
// exercising the snapshot path unchanged.
/**
 * WP8 - the snapshot group is published inside ONE transaction that locks
 * `agent_activity` and re-checks the gate under that lock. These suites are
 * about sync/single-flight, not about the gate, so the fake client answers
 * "nothing in flight, and the activity generation did not move".
 */
const mockDbQuery = vi.fn(async (sql: string) =>
  String(sql).includes("MAX(id)")
    ? { rows: [{ max_id: "0", max_updated_at: "epoch", row_count: "0" }], rowCount: 1 }
    : { rows: [], rowCount: 0 },
);
const fakeDbClient = { query: (sql: string, params?: unknown[]) => mockDbQuery(sql, params) };
vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => fakeDbClient,
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(fakeDbClient),
}));

const mockHasPendingActivity = vi.fn();
vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  hasPendingActivityForWallets: (...a: unknown[]) => mockHasPendingActivity(...a),
}));

const { syncWalletBalances, fullBalanceSync, selectiveBalanceSync, computeBalanceUsd } = await import(
  "../../../vex-agent/sync/balance-sync.js"
);

const EVM_A = "0xAAAaaa";
const EVM_B = "0xBBBbbb";
const SOL_A = "SoLaNaAddrAAA";

function emptyScan(scannedChainIds: number[] = []) {
  return { tokens: [], scannedChainIds, chainErrors: [] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockResolvedValue(emptyScan());
  mockLocalSync.mockResolvedValue({ chainId: 4663, tokensUpdated: 0, skipped: true });
  // Khalani registry WITHOUT 4663 (the real-world state today).
  mockGetCachedKhalaniChains.mockResolvedValue([
    { id: 1, name: "Ethereum", type: "eip155" },
    { id: 8453, name: "Base", type: "eip155" },
  ]);
  mockResolveChainId.mockImplementation(() => {
    throw new Error("unsupported");
  });
  mockGetBalances.mockResolvedValue([]);
  mockGetBalancesByChain.mockResolvedValue([]);
  mockGetLatestSnapshot.mockResolvedValue(null);
  mockInsertSnapshot.mockResolvedValue({ snapshotId: 1, pnlVsPrev: null });
  mockHasPendingActivity.mockResolvedValue(false);
  // Default inventory: one EVM + one Solana wallet.
  mockListWallets.mockImplementation((family: string) =>
    family === "solana"
      ? [{ id: "sol_1", address: SOL_A, label: "Solana 1", createdAt: "" }]
      : [{ id: "evm_1", address: EVM_A, label: "EVM 1", createdAt: "" }],
  );
});

// ── syncWalletBalances ──────────────────────────────────────────

describe("syncWalletBalances", () => {
  it("syncs the GIVEN address (no global primary lookup) and replaces per chain", async () => {
    mockScan.mockResolvedValue({
      tokens: [
        { chainId: 1, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "1000000", price: { usd: "1.0" } } },
        { chainId: 8453, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "500000", price: { usd: "1.0" } } },
      ],
      scannedChainIds: [1, 8453],
      chainErrors: [],
    });

    const result = await syncWalletBalances("eip155", EVM_A);

    expect(result.walletFamily).toBe("eip155");
    expect(result.walletAddress).toBe(EVM_A);
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: undefined });
    expect(mockReplaceBalances).toHaveBeenCalledTimes(2); // chain 1 + 8453
  });

  it("forwards a chainIds filter to the scan", async () => {
    await syncWalletBalances("eip155", EVM_A, [1, 8453]);
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: [1, 8453] });
  });

  // ── Native top-up MUST stay off on the projection path ──────────
  // The sync path full-replaces proj_balances per chain. If it opted into the
  // EVM native top-up, a transient native RPC failure could drop a previously
  // cached synthetic native row from the replace set. Assert the scan is invoked
  // WITHOUT includeNative (so the scanner's default-false path keeps it native-
  // free) and that a synthetic native row is never written.
  it("never requests the native top-up (no includeNative) so it cannot delete cached native rows", async () => {
    const NATIVE_SENTINEL = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    // Even though a real RPC would report 5 ETH, the sync scan returns ERC-20s
    // only - the mock proves syncWalletBalances asks for a native-free scan.
    mockScan.mockResolvedValue({
      tokens: [
        { chainId: 1, address: "0xUSDC", symbol: "USDC", name: "USD Coin", decimals: 6, extensions: { balance: "1000000", price: { usd: "1.0" } } },
      ],
      scannedChainIds: [1],
      chainErrors: [],
    });

    await syncWalletBalances("eip155", EVM_A);

    // The sync call carries no includeNative flag at all.
    const [scanArg] = mockScan.mock.calls[0] as [Record<string, unknown>];
    expect(scanArg).not.toHaveProperty("includeNative");
    expect(scanArg.includeNative).toBeUndefined();

    // The per-chain replace set written to proj_balances has no synthetic native row.
    const replacedRows = mockReplaceBalances.mock.calls.flatMap(
      (call) => (call[2] as Array<{ tokenAddress: string }>),
    );
    expect(
      replacedRows.some((row) => row.tokenAddress.toLowerCase() === NATIVE_SENTINEL.toLowerCase()),
    ).toBe(false);
  });
});

// ── fullBalanceSync ─────────────────────────────────────────────

describe("fullBalanceSync", () => {
  it("snapshots EVERY inventory wallet under one shared snapshot_group_id", async () => {
    // Two EVM + one Solana wallet in the inventory.
    mockListWallets.mockImplementation((family: string) =>
      family === "solana"
        ? [{ id: "sol_1", address: SOL_A, label: "S1", createdAt: "" }]
        : [
            { id: "evm_1", address: EVM_A, label: "E1", createdAt: "" },
            { id: "evm_2", address: EVM_B, label: "E2", createdAt: "" },
          ],
    );
    let n = 0;
    mockInsertSnapshot.mockImplementation(async () => ({ snapshotId: ++n, pnlVsPrev: null }));

    const result = await fullBalanceSync();

    expect(result.wallets).toHaveLength(3);
    expect(result.snapshots).toHaveLength(3);
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(3);

    // Every per-wallet row from this cycle shares ONE group id.
    const groupIds = new Set(
      mockInsertSnapshot.mock.calls.map((c) => (c[0] as { snapshotGroupId: string }).snapshotGroupId),
    );
    expect(groupIds.size).toBe(1);
    expect(result.snapshotGroupId).toBe([...groupIds][0]);

    // One snapshot per distinct wallet address (no single global snapshot).
    const addrs = mockInsertSnapshot.mock.calls.map((c) => (c[0] as { walletAddress: string }).walletAddress);
    expect(addrs).toEqual(expect.arrayContaining([EVM_A, EVM_B, SOL_A]));
    const families = mockInsertSnapshot.mock.calls.map((c) => (c[0] as { walletFamily: string }).walletFamily);
    expect(families).toEqual(expect.arrayContaining(["eip155", "solana"]));
  });

  it("aggregates totalUsd across wallets and tags each with its family", async () => {
    mockGetBalances.mockResolvedValue([
      { walletFamily: "eip155", walletAddress: EVM_A, chainId: 1, tokenAddress: "0xUSDC", tokenSymbol: "USDC", tokenName: null, balanceRaw: "1", balanceUsd: 100, priceUsd: 1, decimals: 6 },
    ]);
    const result = await fullBalanceSync();
    // 1 EVM + 1 Solana, each totalUsd 100 → aggregate 200.
    expect(result.totalUsd).toBe(200);
  });
});

// ── Wave P: the group-wide no-pending snapshot guard ────────────
//
// A snapshot taken while a transaction is in flight records a balance the user
// never actually held, and every later `pnlVsPrev` is computed against it. The
// guard therefore suppresses the snapshot for the WHOLE cycle, never per wallet.

describe("fullBalanceSync - snapshot guard", () => {
  const threeWallets = (family: string) =>
    family === "solana"
      ? [{ id: "sol_1", address: SOL_A, label: "S1", createdAt: "" }]
      : [
          { id: "evm_1", address: EVM_A, label: "E1", createdAt: "" },
          { id: "evm_2", address: EVM_B, label: "E2", createdAt: "" },
        ];

  it("skips the snapshot GROUP-WIDE while any pending activity exists", async () => {
    mockListWallets.mockImplementation(threeWallets);
    mockHasPendingActivity.mockResolvedValue(true);

    const result = await fullBalanceSync();

    // Not one partial group - ZERO snapshot rows. A half-populated
    // snapshotGroupId is the failure this guard exists to prevent.
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    expect(result.snapshots).toEqual([]);
  });

  it("still refreshes balances for every wallet while pending", async () => {
    mockListWallets.mockImplementation(threeWallets);
    mockHasPendingActivity.mockResolvedValue(true);

    const result = await fullBalanceSync();

    // Suppressing balances too would freeze the portfolio display for the whole
    // duration of a pending swap. Only the SNAPSHOT is deferred.
    expect(result.wallets).toHaveLength(3);
    expect(mockScan).toHaveBeenCalled();
  });

  it("asks the predicate ONCE, before the wallet loop, for every wallet at once", async () => {
    mockListWallets.mockImplementation(threeWallets);

    await fullBalanceSync();

    expect(mockHasPendingActivity).toHaveBeenCalledTimes(1);
    expect(mockHasPendingActivity.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining([EVM_A, EVM_B, SOL_A]),
    );
  });

  it("resumes the full snapshot group once everything has terminalized", async () => {
    mockListWallets.mockImplementation(threeWallets);
    mockHasPendingActivity.mockResolvedValue(true);
    await fullBalanceSync();
    expect(mockInsertSnapshot).not.toHaveBeenCalled();

    mockHasPendingActivity.mockResolvedValue(false);
    let n = 0;
    mockInsertSnapshot.mockImplementation(async () => ({ snapshotId: ++n, pnlVsPrev: null }));

    const resumed = await fullBalanceSync();

    // The whole group lands in ONE cycle, so `pnlVsPrev` is never computed from
    // a snapshot set that covers only some of the wallets.
    expect(resumed.snapshots).toHaveLength(3);
    const groupIds = new Set(
      mockInsertSnapshot.mock.calls.map((c) => (c[0] as { snapshotGroupId: string }).snapshotGroupId),
    );
    expect(groupIds.size).toBe(1);
  });

  it("snapshot:'always' NO LONGER bypasses the guard (WP8)", async () => {
    mockListWallets.mockImplementation(threeWallets);
    mockHasPendingActivity.mockResolvedValue(true);

    // It used to skip the probe entirely on the theory that a startup snapshot
    // and a user refresh are "authoritative by design". They are not: neither
    // makes a half-settled portfolio true, and the row they write becomes the
    // baseline every later P&L figure is measured against. There is no caller
    // important enough to corrupt the baseline for.
    const result = await fullBalanceSync({ snapshot: "always" });

    expect(mockHasPendingActivity).toHaveBeenCalledWith([EVM_A, EVM_B, SOL_A]);
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    expect(result.snapshots).toHaveLength(0);
    expect(result.snapshotSkippedReason).toBe("in_flight_money_state");
    // Balances still refreshed - only publication was withheld.
    expect(result.wallets).toHaveLength(3);
  });

  it("a failed pending probe defers the snapshot - it never guesses 'settled'", async () => {
    mockListWallets.mockImplementation(threeWallets);
    mockHasPendingActivity.mockRejectedValue(new Error("db unavailable"));

    const result = await fullBalanceSync();

    // A missing snapshot is recoverable on the next cycle; a wrong one poisons
    // `pnlVsPrev` for every cycle after it.
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    expect(result.wallets).toHaveLength(3);
  });
});

// ── selectiveBalanceSync ────────────────────────────────────────

describe("selectiveBalanceSync", () => {
  it("syncs ALL inventory wallets for the affected family and never snapshots", async () => {
    mockListWallets.mockImplementation((family: string) =>
      family === "solana"
        ? []
        : [
            { id: "evm_1", address: EVM_A, label: "E1", createdAt: "" },
            { id: "evm_2", address: EVM_B, label: "E2", createdAt: "" },
          ],
    );

    const result = await selectiveBalanceSync("eip155");

    expect(result.families).toEqual(["eip155"]);
    expect(result.wallets).toHaveLength(2);
    expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ address: EVM_A, family: "eip155" }));
    expect(mockScan).toHaveBeenCalledWith(expect.objectContaining({ address: EVM_B, family: "eip155" }));
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it("returns an empty result (no throw) when the family has no inventory wallets", async () => {
    mockListWallets.mockReturnValue([]);
    const result = await selectiveBalanceSync("solana");
    expect(result.wallets).toHaveLength(0);
    expect(result.tokensUpdated).toBe(0);
  });
});

// ── Local-chain routing (Wave 2) ────────────────────────────────
// Proves the direct-RPC path is wired for the local registry chain (4663) and,
// critically, that Khalani chains keep their exact pre-Wave-2 behavior.
describe("local-chain routing", () => {
  it("full EVM sync also invokes the local direct-RPC path for chain 4663", async () => {
    await syncWalletBalances("eip155", EVM_A);
    expect(mockLocalSync).toHaveBeenCalledWith("eip155", EVM_A, 4663);
    // Khalani still scanned with the all-chains filter - unchanged.
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: undefined });
  });

  it("routes a local chain id (4663) to the local path and NEVER calls Khalani", async () => {
    await syncWalletBalances("eip155", EVM_A, [4663]);
    expect(mockLocalSync).toHaveBeenCalledWith("eip155", EVM_A, 4663);
    // Only-local scope: an empty Khalani filter would mean "all chains", so the
    // Khalani scan must not run at all.
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("a mixed scope sends only the non-local ids to Khalani", async () => {
    await syncWalletBalances("eip155", EVM_A, [1, 4663, 8453]);
    expect(mockLocalSync).toHaveBeenCalledWith("eip155", EVM_A, 4663);
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: [1, 8453] });
  });

  it("the solana family never touches the local EVM path", async () => {
    await syncWalletBalances("solana", SOL_A);
    expect(mockLocalSync).not.toHaveBeenCalled();
  });

  it("merges local token counts into the wallet result", async () => {
    mockLocalSync.mockResolvedValue({ chainId: 4663, tokensUpdated: 3, skipped: false });
    const res = await syncWalletBalances("eip155", EVM_A);
    expect(res.tokensUpdated).toBe(3); // 0 khalani + 3 local
    expect(res.chainsUpdated).toBeGreaterThanOrEqual(1);
  });

  // ── Khalani-first partition (Codex final-review item 2) ────────
  it("Khalani WINS when its registry lists 4663 - local path not used", async () => {
    mockGetCachedKhalaniChains.mockResolvedValue([
      { id: 1, name: "Ethereum", type: "eip155" },
      { id: 4663, name: "Robinhood Chain", type: "eip155" },
    ]);

    // Filtered scope: 4663 routes to Khalani, not the local path.
    await syncWalletBalances("eip155", EVM_A, [4663]);
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: [4663] });
    expect(mockLocalSync).not.toHaveBeenCalled();

    // Unfiltered scope: the all-chains Khalani scan covers 4663; no local sync.
    mockScan.mockClear();
    mockLocalSync.mockClear();
    await syncWalletBalances("eip155", EVM_A);
    expect(mockScan).toHaveBeenCalledWith({ address: EVM_A, family: "eip155", chainIds: undefined });
    expect(mockLocalSync).not.toHaveBeenCalled();
  });

  it("fails OPEN to local-registry partition when the Khalani registry fetch fails", async () => {
    mockGetCachedKhalaniChains.mockRejectedValue(new Error("registry down"));
    await syncWalletBalances("eip155", EVM_A, [4663]);
    // 4663 still syncs via the local path during a Khalani outage.
    expect(mockLocalSync).toHaveBeenCalledWith("eip155", EVM_A, 4663);
    expect(mockScan).not.toHaveBeenCalled();
  });
});

/**
 * The `balanceUsd` column of a projected row.
 *
 * MIGRATED 2026-08-31 from `khalani-price-fallback.test.ts`, which owned this
 * arithmetic while it lived beside the price fallback. The fallback moved to
 * `tools/khalani/balance-price-enrichment.ts` and works on provider rows, so
 * the DB-row arithmetic stayed here with its only consumer, the sync mapper.
 */
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
