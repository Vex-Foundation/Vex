/**
 * `fullBalanceSync` SINGLE-FLIGHT (Wave P, Blocker 3).
 *
 * The damage this prevents: `fullBalanceSync` mints a fresh `snapshotGroupId`
 * per call and inserts a full set of per-wallet snapshot rows, so two calls
 * overlapping IN TIME record two competing groups for one moment and corrupt
 * the `pnlVsPrev` chain for every wallet. The mutex previously sat on
 * `refreshPortfolioNow` alone, guarding one of five callers - startup, the
 * periodic `balances` job and both sync-worker branches called the unguarded
 * function directly, so the most likely overlap of all (a user pressing refresh
 * during the 300 s periodic run) was entirely unguarded.
 *
 * What is pinned here:
 *
 * 1. NEVER TWO CORES IN FLIGHT, whatever the mix of callers.
 * 2. COMPATIBLE callers JOIN - one run, ONE snapshot group.
 * 3. An `"always"` caller does NOT join a `"when-settled"` run, because that
 *    run's snapshot may have been suppressed; it QUEUES and takes its own. Two
 *    groups is the CORRECT outcome there - they are sequential moments, not a
 *    contested one - and the user's explicit refresh is not silently answered
 *    with a cycle that recorded nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListWallets = vi.fn();
vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (family: string) => mockListWallets(family),
}));

/** Concurrency probe: the scan is the core's first real await, so it brackets a run. */
let concurrentScans = 0;
let maxConcurrentScans = 0;
let releaseScan: (() => void) | null = null;

const mockScan = vi.fn(async () => {
  concurrentScans++;
  maxConcurrentScans = Math.max(maxConcurrentScans, concurrentScans);
  await new Promise<void>((resolve) => {
    releaseScan = resolve;
  });
  concurrentScans--;
  return { tokens: [], scannedChainIds: [8453], chainErrors: [] };
});
vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: (...args: Parameters<typeof mockScan>) => mockScan(...args),
}));

vi.mock("@tools/khalani/chains.js", () => ({
  getCachedKhalaniChains: () => [{ chainId: 8453, family: "eip155", name: "base" }],
  resolveChainId: () => 8453,
}));

vi.mock("../../../vex-agent/sync/local-chain-balance-sync.js", () => ({
  syncLocalChainForWallet: () => ({ chainId: 0, tokensUpdated: 0, skipped: true }),
}));

vi.mock("../../../vex-agent/sync/pendle-enrichment.js", () => ({
  enrichPendleBalances: (_f: string, _a: string, _c: number, rows: unknown) => rows,
  seedPendleChainBalances: (_f: string, _a: string, chainId: number) => ({
    chainId,
    tokensUpdated: 0,
    skipped: true,
  }),
}));

const mockInsertSnapshot = vi.fn();
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: vi.fn().mockResolvedValue(0),
  getBalances: vi.fn().mockResolvedValue([]),
  getBalancesByChain: vi.fn().mockResolvedValue([]),
  insertSnapshot: (...a: unknown[]) => mockInsertSnapshot(...a),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  getSnapshotHistory: vi.fn().mockResolvedValue([]),
}));

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

const { fullBalanceSync } = await import("../../../vex-agent/sync/balance-sync.js");
const { resetBalanceSyncSingleFlight, canJoinInFlightSync } = await import(
  "../../../vex-agent/sync/balance-sync/single-flight.js"
);

/** Let the currently-parked scan finish, then let its microtasks drain. */
async function releaseInFlightScan(): Promise<void> {
  const release = releaseScan;
  releaseScan = null;
  release?.();
  await vi.waitFor(() => {
    expect(releaseScan === null || typeof releaseScan === "function").toBe(true);
  });
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  resetBalanceSyncSingleFlight();
  concurrentScans = 0;
  maxConcurrentScans = 0;
  releaseScan = null;
  mockListWallets.mockImplementation((family: string) =>
    family === "evm" ? [{ address: "0xWALLET" }] : [],
  );
  mockHasPendingActivity.mockResolvedValue(false);
  mockInsertSnapshot.mockResolvedValue({ snapshotId: 1, pnlVsPrev: null });
});

describe("the join/queue policy rule", () => {
  it("a when-settled caller may adopt any run; an always caller may adopt only another always", () => {
    expect(canJoinInFlightSync("when-settled", "when-settled")).toBe(true);
    expect(canJoinInFlightSync("when-settled", "always")).toBe(true);
    expect(canJoinInFlightSync("always", "always")).toBe(true);
    // The one unsafe direction: the in-flight run may have SUPPRESSED its
    // snapshot, and "record what is true now" cannot be answered with that.
    expect(canJoinInFlightSync("always", "when-settled")).toBe(false);
  });
});

describe("overlapping callers", () => {
  it("periodic + worker (both when-settled) join into ONE run and ONE snapshot group", async () => {
    // Both background branches called `fullBalanceSync` directly before this fix.
    const periodic = fullBalanceSync({ snapshot: "when-settled" });
    const worker = fullBalanceSync({ snapshot: "when-settled" });

    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    await releaseInFlightScan();

    const [a, b] = await Promise.all([periodic, worker]);
    expect(maxConcurrentScans).toBe(1);
    expect(a.snapshotGroupId).toBe(b.snapshotGroupId);
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a manual refresh joins an in-flight ALWAYS run - one group, one snapshot", async () => {
    const startup = fullBalanceSync({ snapshot: "always" });
    const manual = fullBalanceSync({ snapshot: "always" });

    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    await releaseInFlightScan();

    const [a, b] = await Promise.all([startup, manual]);
    expect(maxConcurrentScans).toBe(1);
    expect(a.snapshotGroupId).toBe(b.snapshotGroupId);
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(1);
  });

  it("a manual refresh QUEUES behind a periodic run instead of overlapping it", async () => {
    // The periodic run suppresses its snapshot (something is in flight) - which
    // is exactly why the manual refresh must not adopt its result.
    mockHasPendingActivity.mockResolvedValue(true);

    const periodic = fullBalanceSync({ snapshot: "when-settled" });
    const manual = fullBalanceSync({ snapshot: "always" });

    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    // The queued run has NOT started: the two never share a moment in time.
    expect(mockScan).toHaveBeenCalledTimes(1);
    await releaseInFlightScan();

    const periodicResult = await periodic;
    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(2));
    await releaseInFlightScan();
    const manualResult = await manual;

    expect(maxConcurrentScans).toBe(1);
    // Sequential moments, not a contested one: the refresh got its OWN cycle
    // and its own group id rather than adopting an answer computed earlier.
    //
    // WP8 changed what the refresh's own cycle concludes. `"always"` no longer
    // bypasses the guard, so with something still in flight BOTH runs withhold
    // publication - the queue/join distinction is now about freshness (whose
    // moment is evaluated), never about a licence to publish regardless.
    expect(periodicResult.snapshots).toHaveLength(0);
    expect(manualResult.snapshots).toHaveLength(0);
    expect(manualResult.snapshotSkippedReason).toBe("in_flight_money_state");
    expect(manualResult.snapshotGroupId).not.toBe(periodicResult.snapshotGroupId);
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it("a queued run still starts after the run ahead of it REJECTED", async () => {
    mockScan.mockImplementationOnce(async () => {
      throw new Error("provider down");
    });

    const periodic = fullBalanceSync({ snapshot: "when-settled" });
    const manual = fullBalanceSync({ snapshot: "always" });

    // A failed periodic sync is not a reason to drop a user's explicit refresh.
    await expect(periodic).rejects.toThrow("provider down");
    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(2));
    await releaseInFlightScan();

    await expect(manual).resolves.toMatchObject({ snapshots: expect.any(Array) });
  });

  it("a caller arriving AFTER the previous run settled starts a fresh run", async () => {
    const first = fullBalanceSync({ snapshot: "always" });
    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(1));
    await releaseInFlightScan();
    const firstResult = await first;

    const second = fullBalanceSync({ snapshot: "always" });
    await vi.waitFor(() => expect(mockScan).toHaveBeenCalledTimes(2));
    await releaseInFlightScan();
    const secondResult = await second;

    // The slot is released, not leaked: sequential refreshes are still two
    // distinct, correctly-ordered moments.
    expect(secondResult.snapshotGroupId).not.toBe(firstResult.snapshotGroupId);
    expect(maxConcurrentScans).toBe(1);
  });
});
