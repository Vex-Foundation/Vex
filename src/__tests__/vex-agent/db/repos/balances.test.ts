/**
 * balances repo - per-wallet portfolio snapshot semantics (puzzle 5 phase 5E-1).
 * Mocks the db client to assert SQL + params without a live Postgres.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

let mockQueryOne: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
let mockQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

function resetMocks() {
  mockQueryOne = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>().mockResolvedValue(null);
  mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>().mockResolvedValue([]);
}
resetMocks();

// `insertSnapshot` / `getLatestSnapshot` now take an optional `Executor` so a
// snapshot GROUP can be published inside one transaction (WP8). The default
// executor is still the shared pool, so the SQL and params these tests assert
// on are unchanged - they just arrive through the `…With` helpers.
// Both consumers below take `unknown`, so the stub needs no cast.
const POOL = { query: vi.fn() };
vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  queryWith: (_e: unknown, sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOneWith: (_e: unknown, sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  executeWith: vi.fn().mockResolvedValue(1),
  execute: vi.fn().mockResolvedValue(1),
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(POOL),
  getPool: () => POOL,
}));

const repo = await import("@vex-agent/db/repos/balances.js");

beforeEach(() => {
  resetMocks();
});

const findCall = (calls: unknown[][], needle: string): unknown[] | undefined =>
  calls.find((c) => String(c[0]).includes(needle));

describe("insertSnapshot - per-wallet PnL", () => {
  it("writes wallet dimension + group id and null PnL for a wallet's FIRST snapshot", async () => {
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO proj_portfolio_snapshots")) return { id: 42 };
      return null; // getLatestSnapshot - no prior row for this wallet
    });

    const res = await repo.insertSnapshot({
      walletFamily: "eip155",
      walletAddress: "0xA",
      snapshotGroupId: "group-1",
      totalUsd: 1500,
      positions: {},
      activeChains: ["1"],
    });

    expect(res).toEqual({ snapshotId: 42, pnlVsPrev: null });

    // PnL baseline lookup is scoped to THIS wallet (atomic family+address).
    const select = findCall(mockQueryOne.mock.calls, "SELECT * FROM proj_portfolio_snapshots");
    expect(select?.[1]).toEqual(["eip155", "0xA"]);

    // INSERT carries the wallet dimension + group id; pnl params are null.
    const insert = findCall(mockQueryOne.mock.calls, "INSERT INTO proj_portfolio_snapshots");
    const params = insert?.[1] as unknown[];
    expect(params[0]).toBe("eip155"); // wallet_family
    expect(params[1]).toBe("0xA"); // wallet_address
    expect(params[2]).toBe("group-1"); // snapshot_group_id
    expect(params[6]).toBeNull(); // pnl_vs_prev
    expect(params[7]).toBeNull(); // pnl_pct_vs_prev
  });

  it("computes PnL against the SAME wallet's previous snapshot", async () => {
    mockQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("INSERT INTO proj_portfolio_snapshots")) return { id: 43 };
      return { id: 42, wallet_family: "eip155", wallet_address: "0xA", snapshot_group_id: "group-0", total_usd: 1000, positions: {}, active_chains: ["1"], pnl_vs_prev: null, pnl_pct_vs_prev: null, source: "sync", created_at: "2026-05-24T00:00:00.000Z" };
    });

    const res = await repo.insertSnapshot({
      walletFamily: "eip155",
      walletAddress: "0xA",
      snapshotGroupId: "group-1",
      totalUsd: 1500,
      positions: {},
      activeChains: ["1"],
    });

    expect(res.pnlVsPrev).toBe(500);
    const insert = findCall(mockQueryOne.mock.calls, "INSERT INTO proj_portfolio_snapshots");
    expect((insert?.[1] as unknown[])[6]).toBe(500); // pnl_vs_prev
  });
});

describe("getTotalUsd - wallet set filter", () => {
  it("filters by the wallet set with ANY()", async () => {
    mockQueryOne.mockResolvedValue({ total: "250" });
    await repo.getTotalUsd(["0xA", "0xB"]);
    const call = mockQueryOne.mock.calls[0];
    expect(String(call[0])).toContain("wallet_address = ANY($1::text[])");
    expect(call[1]).toEqual([["0xA", "0xB"]]);
  });

  it("returns 0 for an EMPTY set WITHOUT querying (never global)", async () => {
    const total = await repo.getTotalUsd([]);
    expect(total).toBe(0);
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  it("sums across all wallets when the set is undefined (legacy/global)", async () => {
    mockQueryOne.mockResolvedValue({ total: "250" });
    await repo.getTotalUsd();
    expect(String(mockQueryOne.mock.calls[0][0])).not.toContain("wallet_address");
  });
});

describe("aggregate snapshots - per-cycle, complete groups only", () => {
  it("groups by snapshot_group_id (complete-group HAVING) + computes pnl deltas + flattens chains", async () => {
    mockQuery.mockResolvedValue([
      { snapshot_group_id: "g1", total_usd: "1000", at: "2026-05-24T00:00:00.000Z", chains: [["1"], ["8453"]] },
      { snapshot_group_id: "g2", total_usd: "1500", at: "2026-05-24T01:00:00.000Z", chains: [["1"], ["1"]] },
    ]);
    const res = await repo.getAggregateSnapshots(["0xA", "0xB"], "7d");
    const call = mockQuery.mock.calls[0];
    expect(String(call[0])).toContain("HAVING COUNT(DISTINCT wallet_address) = $2");
    expect(call[1]).toEqual([["0xA", "0xB"], 2]);
    expect(res).toHaveLength(2);
    expect(res[0].pnlVsPrev).toBeNull(); // first cycle has no baseline
    expect(res[1].pnlVsPrev).toBe(500); // 1500 - 1000
    expect([...res[0].activeChains].sort()).toEqual(["1", "8453"]); // flattened + deduped
    expect(res[1].activeChains).toEqual(["1"]);
  });

  it("returns [] for an empty wallet set without querying", async () => {
    const res = await repo.getAggregateSnapshots([], "7d");
    expect(res).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("getLatestAggregateSnapshot: latest complete cycle + pnl vs previous (LIMIT 2)", async () => {
    mockQuery.mockResolvedValue([
      { snapshot_group_id: "g2", total_usd: "1500", at: "2026-05-24T01:00:00.000Z", chains: [["1"]] },
      { snapshot_group_id: "g1", total_usd: "1000", at: "2026-05-24T00:00:00.000Z", chains: [["1"]] },
    ]);
    const res = await repo.getLatestAggregateSnapshot(["0xA", "0xB"]);
    expect(String(mockQuery.mock.calls[0][0])).toContain("LIMIT 2");
    expect(res?.totalUsd).toBe(1500);
    expect(res?.pnlVsPrev).toBe(500);
  });

  it("getLatestAggregateSnapshot returns null for an empty set without querying", async () => {
    const res = await repo.getLatestAggregateSnapshot([]);
    expect(res).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe("getLatestSnapshot / getSnapshotHistory - wallet scoping", () => {
  it("scopes the latest-snapshot query to the wallet filter", async () => {
    mockQueryOne.mockResolvedValue(null);
    await repo.getLatestSnapshot({ walletFamily: "solana", walletAddress: "SoLA" });
    const call = mockQueryOne.mock.calls[0];
    expect(String(call[0])).toContain("wallet_family = $1 AND wallet_address = $2");
    expect(call[1]).toEqual(["solana", "SoLA"]);
  });

  it("scopes history to the wallet filter", async () => {
    mockQuery.mockResolvedValue([]);
    await repo.getSnapshotHistory("7d", { walletFamily: "eip155", walletAddress: "0xA" });
    const call = mockQuery.mock.calls[0];
    expect(String(call[0])).toContain("wallet_family = $1 AND wallet_address = $2");
    expect(call[1]).toEqual(["eip155", "0xA"]);
  });
});
