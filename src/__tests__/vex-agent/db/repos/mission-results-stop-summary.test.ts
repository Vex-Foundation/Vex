/**
 * mission_results reads project the run's agent-authored `stop_summary`.
 *
 * The prose lives on `mission_runs.stop_summary` (written by the
 * `mission_stop` tool). The ledger deliberately does NOT copy it — the read
 * JOINs the run row so there is exactly one source of truth and no migration
 * is needed to surface it.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

let mockQuery: Mock;
let mockQueryOne: Mock;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, p?: unknown[]) => mockQuery(sql, p),
  queryOne: (sql: string, p?: unknown[]) => mockQueryOne(sql, p),
  execute: vi.fn(async () => 1),
  queryOneWith: vi.fn(async () => null),
  executeWith: vi.fn(async () => 1),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [] })) }),
  ),
}));

const repo = await import("@vex-agent/db/repos/mission-results.js");

/** A raw joined row as Postgres returns it. */
function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "res-1",
    mission_id: "mission-1",
    mission_run_id: "run-1",
    session_id: "sess-1",
    wallet_address: "0xAbC",
    chain_id: 4663,
    seq_no: 7,
    goal_snippet: "grow ETH +8%",
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: "2026-01-01T01:00:00.000Z",
    duration_s: 3600,
    bankroll_start_eth: "0.012",
    bankroll_end_eth: "0.0118",
    pnl_eth: "-0.0002",
    pnl_pct: "-1.6",
    eth_price_usd_start: "3000",
    eth_price_usd_end: "3000",
    trades: 2,
    outcome: "completed",
    stop_reason: "goal_reached",
    stop_summary: "- Looked at 12 trending coins\n- Ended about even",
    open_positions_json: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockQuery = vi.fn(async () => []);
  mockQueryOne = vi.fn(async () => null);
});

describe("listResultsForWallet", () => {
  it("JOINs mission_runs so the agent's stop_summary rides along", async () => {
    await repo.listResultsForWallet("0xAbC", 10);

    const [sql] = mockQuery.mock.calls[0]!;
    const flat = norm(sql as string);
    expect(flat).toContain("JOIN mission_runs");
    expect(flat).toContain("stop_summary");
  });

  it("maps stop_summary onto the row as stopSummary", async () => {
    mockQuery = vi.fn(async () => [rawRow()]);

    const [row] = await repo.listResultsForWallet("0xAbC", 10);

    expect(row?.stopSummary).toBe("- Looked at 12 trending coins\n- Ended about even");
  });

  it("keeps stopSummary null when the run never authored one", async () => {
    mockQuery = vi.fn(async () => [rawRow({ stop_summary: null })]);

    const [row] = await repo.listResultsForWallet("0xAbC", 10);

    expect(row?.stopSummary).toBeNull();
  });
});

describe("getResultForRun", () => {
  it("JOINs mission_runs for the single-run read too", async () => {
    await repo.getResultForRun("run-1", "0xAbC");

    const [sql] = mockQueryOne.mock.calls[0]!;
    const flat = norm(sql as string);
    expect(flat).toContain("JOIN mission_runs");
    expect(flat).toContain("stop_summary");
  });

  it("maps stop_summary onto the row as stopSummary", async () => {
    mockQueryOne = vi.fn(async () => rawRow());

    const row = await repo.getResultForRun("run-1", "0xAbC");

    expect(row?.stopSummary).toBe("- Looked at 12 trending coins\n- Ended about even");
  });
});
