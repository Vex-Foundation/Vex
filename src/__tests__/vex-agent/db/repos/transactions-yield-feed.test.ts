/**
 * transactions repo — the Pendle `yield` feed (migration 053), mocked-pool unit
 * tests in the established `transactions-lend-prediction.test.ts` shape.
 *
 * THE REGRESSION THIS PINS. Every Pendle mutating tool is `capture: "none"` and
 * its handler writes a receipt-truth `agent_activity` row with `kind = 'yield'`
 * (proven live on Arbitrum with real funds). The feed's activity half was never
 * taught the kind, so a SUCCESSFUL Pendle trade was invisible to the agent's
 * own `agent_scan` — while a FAILED one still surfaced through the failure
 * half, which does know the `yield` product. A history made of losses only.
 *
 * D26, in the same change. Teaching the activity half `yield` without a dedup
 * on the SUCCESS half would render a dual-written trade TWICE, so the success
 * half now carries the mirror of the failure half's `NOT EXISTS` guard. It was
 * introduced when four Pendle families still ALSO emitted the legacy
 * `_tradeCapture` into `proj_activity`; they are now all `capture: "none"`, so
 * the guard no longer has a live Pendle emitter and is kept as the general
 * one-execution-one-row invariant plus the protection for HISTORICAL
 * dual-written rows. Rows written before 053 have no `agent_activity` twin (the
 * migration is deliberately not backfilled) and keep rendering exactly as before.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQuery: QueryMock;

function resetMocks() {
  mockQuery = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>()
    .mockResolvedValue([]);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (sql: string, params?: unknown[]) => mockQuery(sql, params),
  queryOne: vi.fn(),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
}));

const repo = await import("@vex-agent/db/repos/transactions.js");

const ADDRS = ["0xEVM", "SOL"];
const SESSION = "00000000-0000-4000-8000-000000000001";

function lastSql(): string {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1][0];
}

function activityHalf(): string {
  return lastSql().split("FROM agent_activity\n")[0];
}

/** A confirmed `pendle.pt.buy` row, exactly as the handler writes it. */
const CONFIRMED_PT_ROW = {
  source: "agent_activity",
  source_rank: 0,
  id: 501,
  namespace: "pendle",
  product_type: "yield",
  trade_side: null,
  chain: "arbitrum",
  input_token: "USDC",
  input_amount: null,
  output_token: "PT-SIERRA",
  output_amount: null,
  value_usd: "10.0",
  capture_status: null,
  status: "confirmed",
  failure_code: null,
  chain_id: 42161,
  protocol: "pendle",
  tool_id: null,
  duration_ms: null,
  event_role: "yield_pt",
  protocol_execution_id: 9001,
  token_in_address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  token_in_symbol: "USDC",
  token_out_address: "0x0ee083964C815bAED1A2d7F5E3Cec851eC394E7d",
  token_out_symbol: "PT-SIERRA",
  amount_in_raw: "10000000",
  amount_out_raw: "10500000",
  executed_amount_in_raw: "10000000",
  executed_amount_out_raw: "10470610",
  token_in_decimals: 6,
  token_out_decimals: 6,
  chain_family: "evm",
  from_chain_id: null,
  from_chain_slug: null,
  to_chain_id: null,
  to_chain_slug: null,
  provider_order_id: null,
  provider_status: null,
  legs: null,
  tx_hash: "0xpendlept1",
  created_at: "2026-08-01T10:00:00.000000Z",
  cursor_ts: "2026-08-01T10:00:00.000000Z",
};

beforeEach(() => {
  resetMocks();
});

describe("yield rows reach the agent-facing feed (migration 053)", () => {
  it("the activity half admits kind='yield' — a successful Pendle trade is no longer invisible", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(activityHalf()).toContain("kind = 'yield'");
  });

  it("productType='yield' selects the activity half instead of excluding it", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "yield", limit: 20 });
    const half = activityHalf();
    expect(half).not.toContain("FALSE");
    expect(half).toContain("kind = 'yield'");
  });

  it("projects product_type 'yield' — NEVER 'spot'", async () => {
    // `ELSE 'spot'` would state a route, a price and a counterparty that a
    // py.mint (1 -> 2) or a claim (no input leg) never had.
    const half = await (async () => {
      await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
      return activityHalf();
    })();
    expect(half).toContain("WHEN kind = 'yield' THEN 'yield'");
  });

  it("a confirmed yield_pt row maps to ONE feed entry, source 'agent_activity', productType 'yield'", async () => {
    mockQuery.mockResolvedValueOnce([CONFIRMED_PT_ROW]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items).toHaveLength(1);
    const row = res.items[0];
    expect(row.source).toBe("agent_activity");
    expect(row.productType).toBe("yield");
    expect(row.productType).not.toBe("spot");
    expect(row.eventRole).toBe("yield_pt");
    expect(row.status).toBe("confirmed");
    expect(row.amountBasis).toBe("executed");
    expect(row.inputAmount).toBe("10");
    expect(row.outputAmount).toBe("10.47061");
    expect(row.txHash).toBe("0xpendlept1");
  });
});

describe("D26 — the success half's agent_activity dedup", () => {
  it("excludes a proj_activity row whose execution already has an agent_activity row", async () => {
    // The mirror of the failure half's guard. Without it, the four Pendle
    // families that still emit a legacy `_tradeCapture` would render TWICE the
    // moment the activity half learned `yield`.
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(lastSql()).toContain(
      "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = proj_activity.execution_id)",
    );
  });

  it("keeps the failure half's own dedup guard, keyed on protocol_executions", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(lastSql()).toContain(
      "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = protocol_executions.id)",
    );
  });

  it("the guard is unconditional — every productType, not just 'yield'", async () => {
    for (const productType of [undefined, "yield", "spot", "bridge"]) {
      await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType, limit: 20 });
      expect(lastSql()).toContain(
        "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = proj_activity.execution_id)",
      );
    }
  });

  it("a dual-written execution yields exactly ONE entry — the agent_activity one", async () => {
    // Simulates the invariant the SQL enforces: the proj_activity twin of
    // execution 9001 is excluded server-side, so only the receipt-truth row
    // reaches the mapper.
    mockQuery.mockResolvedValueOnce([CONFIRMED_PT_ROW]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe("agent_activity");
    expect(res.items[0].protocolExecutionId).toBe(9001);
  });

  it("a HISTORICAL proj_activity row with no agent_activity twin still renders", async () => {
    // Migration 053 is deliberately not backfilled: pre-053 Pendle history has
    // no receipt evidence and lives only in proj_activity. `execution_id` is
    // nullable there, and a NULL never matches the NOT EXISTS subquery.
    mockQuery.mockResolvedValueOnce([
      {
        source: "success",
        source_rank: 1,
        id: 77,
        namespace: "pendle",
        product_type: "lp",
        trade_side: null,
        chain: "arbitrum",
        input_token: "USDC",
        input_amount: "10",
        output_token: "LP-SIERRA",
        output_amount: "9.9",
        value_usd: "10.0",
        capture_status: "complete",
        status: null,
        failure_code: null,
        chain_id: null,
        protocol: null,
        tool_id: null,
        duration_ms: null,
        legs: null,
        tx_hash: "0xhistoricpendle",
        created_at: "2026-07-01T10:00:00.000000Z",
        cursor_ts: "2026-07-01T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].source).toBe("success");
    expect(res.items[0].txHash).toBe("0xhistoricpendle");
  });
});
