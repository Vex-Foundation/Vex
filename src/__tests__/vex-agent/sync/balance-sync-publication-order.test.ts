/**
 * WP8 at the `fullBalanceSync` level - the two properties that only the whole
 * cycle can show:
 *
 *  1. EVERY snapshot DTO is prepared BEFORE the publishing transaction opens.
 *     The gathering is minutes of provider and database work; doing any of it
 *     while `agent_activity` is locked would block every money-path writer in
 *     the app for that whole time.
 *  2. A lock timeout skips the SNAPSHOT and nothing else. Balances are written
 *     per wallet-chain long before publication and stay fresh regardless - the
 *     user's portfolio must not freeze for the duration of a busy money path.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListWallets = vi.fn();
vi.mock("@tools/wallet/inventory.js", () => ({
  listWallets: (family: string) => mockListWallets(family),
}));

vi.mock("@tools/khalani/balances.js", () => ({
  getTokenBalancesAcrossChains: vi.fn().mockResolvedValue({
    tokens: [{
      chainId: 8453, address: "0xTOKEN", symbol: "T", name: "Token", decimals: 18,
      extensions: { balance: "1000000000000000000", price: { usd: "2" } },
    }],
    scannedChainIds: [8453],
    chainErrors: [],
  }),
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
    chainId, tokensUpdated: 0, skipped: true,
  }),
}));

/** A single ordered trace of everything the cycle does that touches the DB. */
const trace: string[] = [];
let lockError: (Error & { code?: string }) | null = null;

const mockReplaceBalances = vi.fn(async () => {
  trace.push("replace_balances");
  return 0;
});
const mockInsertSnapshot = vi.fn(async () => {
  trace.push("insert_snapshot");
  return { snapshotId: 1, pnlVsPrev: null };
});
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  replaceBalancesForChain: (...a: unknown[]) => mockReplaceBalances(...(a as [])),
  getBalances: vi.fn(async () => {
    trace.push("build_positions_tokens");
    return [];
  }),
  getBalancesByChain: vi.fn(async () => {
    trace.push("build_positions_chains");
    return [];
  }),
  insertSnapshot: (...a: unknown[]) => mockInsertSnapshot(...(a as [])),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  getSnapshotHistory: vi.fn().mockResolvedValue([]),
}));

const fakeClient = {
  query: async (sql: string) => {
    if (sql.includes("LOCK TABLE agent_activity")) {
      trace.push("lock_activity");
      if (lockError) throw lockError;
      return { rows: [], rowCount: 0 };
    }
    if (sql === "BEGIN") trace.push("begin");
    if (sql === "COMMIT") trace.push("commit");
    if (sql === "ROLLBACK") trace.push("rollback");
    if (sql.includes("MAX(id)")) {
      return { rows: [{ max_id: "0", max_updated_at: "epoch", row_count: "0" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};
vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => fakeClient,
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
    await fakeClient.query("BEGIN");
    try {
      const r = await fn(fakeClient);
      await fakeClient.query("COMMIT");
      return r;
    } catch (err) {
      await fakeClient.query("ROLLBACK");
      throw err;
    }
  },
}));

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  hasPendingActivityForWallets: vi.fn().mockResolvedValue(false),
}));

const { fullBalanceSync } = await import("../../../vex-agent/sync/balance-sync.js");
const { resetBalanceSyncSingleFlight } = await import(
  "../../../vex-agent/sync/balance-sync/single-flight.js"
);

beforeEach(() => {
  vi.clearAllMocks();
  resetBalanceSyncSingleFlight();
  trace.length = 0;
  lockError = null;
  mockListWallets.mockImplementation((family: string) =>
    family === "evm"
      ? [{ id: "e1", address: "0xAAA", label: "", createdAt: "" },
         { id: "e2", address: "0xBBB", label: "", createdAt: "" }]
      : [],
  );
});

describe("preparation happens outside the transaction", () => {
  it("finishes every scan and every positions breakdown BEFORE BEGIN", async () => {
    await fullBalanceSync();

    const beginAt = trace.indexOf("begin");
    expect(beginAt).toBeGreaterThan(-1);
    const before = trace.slice(0, beginAt);
    // Both wallets fully scanned and projected before the lock is even asked
    // for: EVERY gathering call in the whole cycle happened before BEGIN.
    expect(before.filter((t) => t === "replace_balances")).toHaveLength(2);
    expect(before.filter((t) => t === "build_positions_chains"))
      .toEqual(trace.filter((t) => t === "build_positions_chains"));
    // Nothing gathered after BEGIN - only the lock, the gate and the inserts.
    expect(trace.slice(beginAt)).toEqual([
      "begin", "lock_activity", "insert_snapshot", "insert_snapshot", "commit",
    ]);
  });
});

describe("a lock timeout", () => {
  it("skips the snapshot while the balance refresh still succeeds", async () => {
    lockError = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });

    const result = await fullBalanceSync();

    // Publication withheld…
    expect(result.snapshots).toEqual([]);
    expect(result.snapshotSkippedReason).toBe("lock_unavailable");
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    // …and the refresh itself completed for every wallet. Suppressing both
    // would freeze the user's portfolio for the duration of a pending swap.
    expect(result.wallets).toHaveLength(2);
    expect(mockReplaceBalances).toHaveBeenCalledTimes(2);
    expect(trace).toContain("rollback");
  });
});
