/**
 * mission_results repo — open/close lifecycle + history reads (mocked pool).
 *
 * A ledger row is OPENED when a run starts (seq_no minted per wallet, under
 * a transaction-scoped advisory lock) and CLOSED when the run finalizes.
 * Pins the SQL shape + params: advisory-lock-then-mint sequencing inside one
 * transaction, idempotent open, close-by-run_id (incl. stop_reason), and
 * newest-first per-wallet history reads.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;
type EMock = Mock<(sql: string, params?: unknown[]) => Promise<number>>;

let mockQuery: QMock;
let mockQueryOne: Mock;
let mockExecute: EMock;
let mockClientQuery: Mock;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, p?: unknown[]) => mockQuery(sql, p),
  queryOne: (sql: string, p?: unknown[]) => mockQueryOne(sql, p),
  execute: (sql: string, p?: unknown[]) => mockExecute(sql, p),
  queryOneWith: vi.fn(async (_client: unknown, sql: string, p?: unknown[]) => {
    if (/COALESCE\(MAX\(seq_no\)/i.test(sql)) return { next_seq: "1" };
    return null;
  }),
  executeWith: vi.fn(async (_client: unknown, sql: string, p?: unknown[]) => {
    mockExecute(sql, p);
    return 1;
  }),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    const client = { query: (...a: unknown[]) => mockClientQuery(...a) };
    return fn(client);
  }),
}));

const repo = await import("@vex-agent/db/repos/mission-results.js");

beforeEach(() => {
  mockQuery = vi.fn(async () => []);
  mockQueryOne = vi.fn(async () => null);
  mockExecute = vi.fn(async () => 1);
  mockClientQuery = vi.fn(async () => ({ rows: [] }));
});

const OPEN = {
  id: "res-1",
  missionId: "mission-1",
  missionRunId: "run-1",
  sessionId: "00000000-0000-4000-8000-000000000001",
  walletAddress: "0xAbC",
  chainId: 4663,
  goalSnippet: "grow ETH +8%",
  bankrollStartEth: 0.012,
  ethPriceUsdStart: 3000,
};

describe("openMissionResult", () => {
  it("acquires a per-wallet advisory lock before minting seq_no", async () => {
    await repo.openMissionResult(OPEN);
    expect(mockClientQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockClientQuery.mock.calls[0]!;
    expect(norm(sql as string)).toContain("pg_advisory_xact_lock(hashtextextended($1, 0))");
    expect(params).toEqual(["mission_results_seq:0xabc"]);
  });

  it("inserts with the minted seq_no and idempotent ON CONFLICT", async () => {
    await repo.openMissionResult(OPEN);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    const s = norm(sql);
    expect(s).toContain("INSERT INTO mission_results");
    expect(s).toContain("'running'");
    expect(s).toContain("ON CONFLICT (mission_run_id) DO NOTHING");
    expect(params).toContain("run-1");
    expect(params).toContain("0xAbC");
    expect(params).toContain(1); // seq_no minted from the mocked MAX(seq_no)+1
  });

  it("mints the next seq_no from the wallet's current MAX(seq_no)", async () => {
    const { queryOneWith } = await import("@vex-agent/db/client.js");
    vi.mocked(queryOneWith).mockResolvedValueOnce({ next_seq: "4" } as never);

    await repo.openMissionResult(OPEN);
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toContain(4);
  });
});

describe("closeMissionResult", () => {
  it("updates the row by run_id with terminal outcome, stop_reason, PnL, and duration", async () => {
    await repo.closeMissionResult({
      missionRunId: "run-1",
      outcome: "completed",
      stopReason: "goal_reached",
      bankrollEndEth: 0.013,
      ethPriceUsdEnd: 3100,
      pnlEth: 0.001,
      pnlPct: 8.33,
      trades: 4,
      openPositions: [{ token: "NOXA", amount: "10" }],
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    const [sql, params] = mockExecute.mock.calls[0]!;
    const s = norm(sql);
    expect(s).toContain("UPDATE mission_results SET");
    expect(s).toContain("WHERE mission_run_id = $1");
    expect(s).toContain("ended_at = NOW()");
    expect(s.toLowerCase()).toContain("duration_s");
    expect(s).toContain("stop_reason = $3");
    expect(params).toContain("run-1");
    expect(params).toContain("completed");
    expect(params).toContain("goal_reached");
    // open_positions serialized as jsonb text, not a raw object
    expect(params!.some((p) => typeof p === "string" && p.includes("NOXA"))).toBe(true);
  });

  it("persists a null stop_reason as-is (e.g. a run that never resolved a reason)", async () => {
    await repo.closeMissionResult({
      missionRunId: "run-1",
      outcome: "stopped",
      stopReason: null,
      bankrollEndEth: null,
      ethPriceUsdEnd: null,
      pnlEth: null,
      pnlPct: null,
      trades: 0,
      openPositions: null,
    });
    const [, params] = mockExecute.mock.calls[0]!;
    expect(params).toContain(null);
  });
});

describe("history reads", () => {
  it("listResultsForWallet reads newest-first for the wallet (case-insensitive)", async () => {
    await repo.listResultsForWallet("0xAbC", 25);
    const [sql, params] = mockQuery.mock.calls[0]!;
    const s = norm(sql);
    // Reads JOIN mission_runs for the agent's stop_summary, so every
    // column reference is table-qualified.
    expect(s).toContain("FROM mission_results r");
    expect(s).toContain("JOIN mission_runs run ON run.id = r.mission_run_id");
    expect(s).toContain("LOWER(r.wallet_address) = LOWER($1)");
    expect(s).toContain("ORDER BY r.seq_no DESC");
    expect(params).toEqual(["0xAbC", 25]);
  });

  it("getResultForRun reads a single row by run_id scoped to its wallet", async () => {
    await repo.getResultForRun("run-1", "0xAbC");
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    expect(norm(sql)).toContain("WHERE r.mission_run_id = $1");
    expect(norm(sql)).toContain("LOWER(r.wallet_address) = LOWER($2)");
    expect(params).toEqual(["run-1", "0xAbC"]);
  });
});
