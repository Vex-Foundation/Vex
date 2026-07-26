/**
 * `listPendingOlderThan`'s new `chainFamily` predicate + the new
 * `listSolanaStagedPending` candidate query (W5 design §4/R3, migration 049,
 * K3) — mocked-pool unit tests mirroring
 * `agent-activity-solana-staged-evidence.test.ts`'s style.
 *
 * Pins:
 *   - `listPendingOlderThan` now REQUIRES a `chainFamily` argument and adds
 *     `AND chain_family = $3` to its SQL (Codex's non-disjointness finding —
 *     the EVM repair sweep and the new Solana sweep must never share a
 *     candidate set);
 *   - `listSolanaStagedPending` targets ONLY `chain_family='solana' AND
 *     status='pending' AND tx_hash IS NOT NULL` rows, ordered oldest-checked
 *     first, bounded by `limit`.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;
type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQueryOne: QueryOneMock;
let mockQuery: QueryMock;

function resetMocks() {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
  mockQuery = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/agent-activity.js");

beforeEach(() => {
  resetMocks();
});

describe("listPendingOlderThan (chainFamily-scoped)", () => {
  it("adds chain_family = $3 to the WHERE clause and passes the family through", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await repo.listPendingOlderThan(90_000, 25, "eip155");

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/submit_attempted_at\s+IS\s+NOT\s+NULL/);
    expect(sql).toContain("chain_family = $3");
    expect(sql).toContain("LIMIT $2");
    expect(params).toEqual([90, 25, "eip155"]);
  });

  it("scopes to 'solana' too when explicitly asked (family-agnostic query shape)", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await repo.listPendingOlderThan(1000, 10, "solana");
    const [, params] = mockQuery.mock.calls[0]!;
    expect(params![2]).toBe("solana");
  });
});

describe("listSolanaStagedPending", () => {
  it("selects pending, chain_family='solana', tx_hash-staged rows ordered oldest-checked first", async () => {
    mockQuery.mockResolvedValueOnce([]);

    await repo.listSolanaStagedPending(25);

    const [sql, params] = mockQuery.mock.calls[0]!;
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/chain_family\s*=\s*'solana'/);
    expect(sql).toMatch(/tx_hash\s+IS\s+NOT\s+NULL/);
    expect(sql).toMatch(/submit_attempted_at\s+IS\s+NOT\s+NULL/);
    expect(sql).toContain("COALESCE(last_checked_at, submit_attempted_at)");
    expect(sql).toContain("LIMIT $1");
    expect(params).toEqual([25]);
  });

  it("maps every returned row", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        id: 9,
        protocol_execution_id: 1,
        event_index: 0,
        event_role: "predict_buy",
        record_version: 1,
        kind: "prediction",
        protocol: "jupiter",
        chain_id: 20011000000,
        chain_slug: "solana",
        status: "pending",
        failure_code: null,
        failure_reason: null,
        token_in_address: null,
        token_in_symbol: null,
        token_in_decimals: null,
        amount_in_human: null,
        amount_in_raw: null,
        token_out_address: null,
        token_out_symbol: null,
        token_out_decimals: null,
        amount_out_human: null,
        amount_out_raw: null,
        executed_amount_in_human: null,
        executed_amount_in_raw: null,
        executed_amount_out_human: null,
        executed_amount_out_raw: null,
        usd_in_est: null,
        usd_out_est: null,
        usd_fee_est: null,
        usd_source: null,
        tx_hash: "5SoLSigBase58",
        from_address: "SoLFromAddr1111111111111111111111111111111",
        nonce: null,
        wallet_address: "SoLFromAddr1111111111111111111111111111111",
        session_id: "00000000-0000-4000-8000-000000000001",
        route_provenance: null,
        from_chain_id: null,
        from_chain_slug: null,
        to_chain_id: null,
        to_chain_slug: null,
        chain_family: "solana",
        provider_order_id: null,
        normalized_route: null,
        provider_status: null,
        evidence_source: null,
        observed_at: null,
        last_attempted_at: null,
        submit_attempted_at: "2026-07-24T10:00:00.000Z",
        recent_blockhash: "11111111111111111111111111111112",
        last_valid_block_height: 12345,
        broadcast_at: null,
        confirmed_at: null,
        last_checked_at: null,
        created_at: "2026-07-24T09:59:00.000Z",
        updated_at: "2026-07-24T10:00:00.000Z",
      },
    ]);

    const rows = await repo.listSolanaStagedPending(25);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(9);
    expect(rows[0]!.chainFamily).toBe("solana");
    expect(rows[0]!.lastValidBlockHeight).toBe(12345);
  });
});
