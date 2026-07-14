/**
 * open-positions repo — multi-wallet identity (puzzle 5 phase 5E-1).
 *
 * The position identity is (namespace, position_type, chain, wallet_address,
 * external_id): two wallets holding a position with the same external_id must
 * NOT collide. Mocks the db client to assert the ON CONFLICT / WHERE shape
 * without a live Postgres.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

let mockExecute: Mock<(sql: string, params?: unknown[]) => Promise<number>>;
let mockQuery: Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

function resetMocks() {
  mockExecute = vi.fn<(sql: string, params?: unknown[]) => Promise<number>>().mockResolvedValue(1);
  mockQuery = vi.fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>().mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: vi.fn().mockResolvedValue(null),
  execute: (sql: string, params?: unknown[]) => mockExecute(sql, params),
  getPool: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/open-positions.js");

beforeEach(() => {
  resetMocks();
});

describe("upsertPosition — multi-wallet identity", () => {
  it("conflict target includes chain + wallet_address (no cross-wallet overwrite)", async () => {
    await repo.upsertPosition({
      namespace: "khalani",
      positionType: "perps",
      chain: "base",
      externalId: "ext-1",
      walletAddress: "0xWalletA",
    });

    const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      "ON CONFLICT (namespace, position_type, chain, wallet_address, external_id) WHERE external_id IS NOT NULL",
    );
    // INSERT params: namespace, position_type, chain, external_id, wallet_address, …
    expect(params[2]).toBe("base"); // chain
    expect(params[4]).toBe("0xWalletA"); // wallet_address
  });

  it("two wallets sharing an external_id resolve to DISTINCT conflict keys", async () => {
    await repo.upsertPosition({ namespace: "khalani", positionType: "perps", chain: "base", externalId: "ext-1", walletAddress: "0xWalletA" });
    await repo.upsertPosition({ namespace: "khalani", positionType: "perps", chain: "base", externalId: "ext-1", walletAddress: "0xWalletB" });

    const walletParams = mockExecute.mock.calls.map((c) => (c[1] as unknown[])[4]);
    expect(walletParams).toEqual(["0xWalletA", "0xWalletB"]);
    // Same external_id, different wallet_address → the conflict key differs, so
    // the DB stores two rows instead of the second overwriting the first.
  });
});

describe("upsertPosition — parameter type inference (incident 2026-07-13)", () => {
  it("casts $9/$10 to ::numeric in every CASE WHEN ... IS NULL use", async () => {
    // Postgres cannot infer a parameter's type from an `IS NULL` test alone.
    // With bare `$9`/`$10`, PREPARE failed with
    // `could not determine data type of parameter $9`, so projectPosition threw
    // and NO perps row was ever written to proj_open_positions (empty POSITIONS
    // panel). The ::numeric casts pin the type to the real column type.
    await repo.upsertPosition({
      namespace: "hyperliquid",
      positionType: "perps",
      chain: "hyperliquid",
      externalId: "ext-1",
      walletAddress: "0xWalletA",
      currentValueUsd: "1000",
      unrealizedPnlUsd: "20",
    });

    const [sql] = mockExecute.mock.calls[0] as [string, unknown[]];
    // Both the VALUES last_refresh_at and the DO UPDATE last_refresh_at use it.
    expect(sql).toContain("CASE WHEN $9::numeric IS NULL AND $10::numeric IS NULL THEN NULL ELSE NOW() END");
    expect(sql).toContain(
      "last_refresh_at = CASE WHEN $9::numeric IS NULL AND $10::numeric IS NULL THEN proj_open_positions.last_refresh_at ELSE NOW() END",
    );
    // The bare, type-ambiguous form must never come back.
    expect(sql).not.toContain("CASE WHEN $9 IS NULL");
  });
});

describe("closePosition — full identity", () => {
  it("matches on namespace + type + chain + wallet + external_id", async () => {
    await repo.closePosition("khalani", "perps", "base", "0xWalletA", "ext-1", "closed");

    const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("chain = $3 AND wallet_address = $4 AND external_id = $5");
    expect(params).toEqual(["khalani", "perps", "base", "0xWalletA", "ext-1", "closed"]);
  });
});

describe("getOpen — wallet set filter", () => {
  it("returns [] for an EMPTY set WITHOUT querying (never global)", async () => {
    const res = await repo.getOpen([]);
    expect(res).toEqual([]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it("scopes to the wallet set with ANY()", async () => {
    await repo.getOpen(["0xA", "0xB"], "khalani");
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("wallet_address = ANY($1::text[])");
    expect(params[0]).toEqual(["0xA", "0xB"]);
  });
});
