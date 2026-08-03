/**
 * transactions repo — Agent Scan Phase 2 (migration 045) bridge-feed unit
 * tests (mocked pool), split out of `transactions.test.ts` by domain under
 * test (same pattern as Cards F1/W0-C/K7's `transactions-lend-prediction.test.ts`:
 * move-only, no assertion changes, no coverage loss) once the parent file
 * crossed the repo's 500-line cap.
 *
 * Pins the bridge (R14/B8/Q2) display contract this file's parent does not
 * repeat: product_type derives from `kind` for every kind (not just bridge);
 * the legs jsonb_agg subquery aggregates every sibling leg keyed by the
 * execution, with no LIMIT (OWNER RULE); confirmed/pending/failed bridge rows
 * map to executed/estimated/null amount bases; a plain swap row carries null
 * bridge-only fields.
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
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![0];
}

beforeEach(() => {
  resetMocks();
});

// ── bridge feed (Agent Scan Phase 2, migration 045) ───────────────────────

describe("agent_activity bridge feed (R14/B8/Q2)", () => {
  it("emits product_type from kind and the legs jsonb_agg subquery (canonical row INCLUDED, no LIMIT)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const activityHalf = lastSql().split("FROM proj_activity")[0]!;
    // W5/R5: product_type derives from kind for every kind, not just bridge.
    expect(activityHalf).toContain("WHEN kind = 'bridge' THEN 'bridge'");
    expect(activityHalf).toContain("WHEN kind = 'lend' THEN 'lend'");
    expect(activityHalf).toContain("WHEN kind = 'prediction' THEN 'prediction'");
    expect(activityHalf).toContain("ELSE 'spot'");
    // The legs subquery aggregates EVERY sibling leg keyed by the execution
    // (the canonical bridge_fill_expected row included) — NO LIMIT (OWNER RULE).
    expect(activityHalf).toContain("jsonb_agg(jsonb_build_object");
    expect(activityHalf).toContain("leg.protocol_execution_id = agent_activity.protocol_execution_id");
    expect(activityHalf).not.toMatch(/jsonb_agg[\s\S]*LIMIT/);
    // Route + provider columns selected.
    expect(activityHalf).toContain("from_chain_id");
    expect(activityHalf).toContain("to_chain_id");
    expect(activityHalf).toContain("provider_order_id");
  });

  it("maps a CONFIRMED bridge with executed evidence → executed amounts + route + legs", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 20, namespace: "khalani",
        product_type: "bridge", trade_side: null, chain: "arbitrum",
        input_token: "USDC", input_amount: null, output_token: "USDC", output_amount: null,
        value_usd: "2.0", capture_status: null, status: "confirmed",
        failure_code: null, chain_id: 42161, protocol: "khalani",
        tool_id: null, duration_ms: null,
        amount_in_raw: "2000000", amount_out_raw: "1990000",
        executed_amount_in_raw: "2000000", executed_amount_out_raw: "1988000",
        token_in_decimals: 6, token_out_decimals: 6,
        from_chain_id: 8453, from_chain_slug: "base",
        to_chain_id: 42161, to_chain_slug: "arbitrum",
        chain_family: "eip155", provider_order_id: "ord_123", provider_status: "filled",
        legs: [
          { eventIndex: 0, role: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", txHash: "0xdeposit", status: "confirmed", failureCode: null },
          { eventIndex: 1, role: "bridge_fill_expected", chainId: 42161, chainSlug: "arbitrum", chainFamily: "eip155", txHash: "0xfill", status: "confirmed", failureCode: null },
        ],
        tx_hash: "0xfill", created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.productType).toBe("bridge");
    expect(row.amountBasis).toBe("executed");
    expect(row.inputAmount).toBe("2"); // 2000000 / 10^6
    expect(row.outputAmount).toBe("1.988"); // executed, NOT the 1.99 quote
    expect(row.fromChainId).toBe(8453);
    expect(row.fromChainSlug).toBe("base");
    expect(row.toChainId).toBe(42161);
    expect(row.chainFamily).toBe("eip155");
    expect(row.providerOrderId).toBe("ord_123");
    expect(row.providerStatus).toBe("filled");
    const legs = row.legs ?? [];
    expect(legs).toHaveLength(2);
    expect(legs[0]?.role).toBe("bridge_deposit");
    expect(legs[0]?.txHash).toBe("0xdeposit");
    expect(legs[1]?.role).toBe("bridge_fill_expected");
    expect(legs[1]?.chainId).toBe(42161);
  });

  it("maps a PENDING bridge → quoted amounts labelled 'estimated' (still settling, never blanked)", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 21, namespace: "relay",
        product_type: "bridge", trade_side: null, chain: "optimism",
        input_token: "ETH", input_amount: null, output_token: "ETH", output_amount: null,
        value_usd: null, capture_status: null, status: "pending",
        failure_code: null, chain_id: 10, protocol: "relay",
        tool_id: null, duration_ms: null,
        amount_in_raw: "1000000000000000", amount_out_raw: "990000000000000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 18, token_out_decimals: 18,
        from_chain_id: 8453, from_chain_slug: "base",
        to_chain_id: 10, to_chain_slug: "optimism",
        chain_family: "eip155", provider_order_id: "req_abc", provider_status: "pending",
        legs: [
          { eventIndex: 0, role: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", txHash: "0xdep2", status: "confirmed", failureCode: null },
          { eventIndex: 1, role: "bridge_fill_expected", chainId: 10, chainSlug: "optimism", chainFamily: "eip155", txHash: null, status: "pending", failureCode: null },
        ],
        tx_hash: null, created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.status).toBe("pending");
    expect(row.amountBasis).toBe("estimated");
    expect(row.inputAmount).toBe("0.001"); // the QUOTE, shown as estimate
    expect(row.outputAmount).toBe("0.00099");
    // The pending fill leg carries a null hash but is preserved (never dropped).
    const legs = row.legs ?? [];
    expect(legs).toHaveLength(2);
    expect(legs[1]?.txHash).toBeNull();
  });

  it("maps a definitively_failed/refunded bridge → NO amount, failureCode preserved (money back ≠ success)", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 22, namespace: "khalani",
        product_type: "bridge", trade_side: null, chain: "arbitrum",
        input_token: "USDC", input_amount: null, output_token: "USDC", output_amount: null,
        value_usd: null, capture_status: null, status: "definitively_failed",
        failure_code: "bridge_refunded", chain_id: 42161, protocol: "khalani",
        tool_id: null, duration_ms: null,
        amount_in_raw: "2000000", amount_out_raw: "1990000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: 6,
        from_chain_id: 8453, from_chain_slug: "base",
        to_chain_id: 42161, to_chain_slug: "arbitrum",
        chain_family: "eip155", provider_order_id: "ord_ref", provider_status: "refunded",
        legs: [
          { eventIndex: 0, role: "bridge_deposit", chainId: 8453, chainSlug: "base", chainFamily: "eip155", txHash: "0xdep3", status: "confirmed", failureCode: null },
          { eventIndex: 1, role: "bridge_fill_expected", chainId: 42161, chainSlug: "arbitrum", chainFamily: "eip155", txHash: null, status: "definitively_failed", failureCode: "bridge_refunded" },
          { eventIndex: 2, role: "bridge_refund", chainId: 8453, chainSlug: "base", chainFamily: "eip155", txHash: "0xrefund", status: "confirmed", failureCode: null },
        ],
        tx_hash: null, created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.status).toBe("definitively_failed");
    expect(row.failureCode).toBe("bridge_refunded");
    expect(row.amountBasis).toBeNull();
    expect(row.inputAmount).toBeNull();
    expect(row.outputAmount).toBeNull();
    // Every leg preserved, incl. the refund evidence row.
    const legs = row.legs ?? [];
    expect(legs).toHaveLength(3);
    expect(legs[2]?.role).toBe("bridge_refund");
    expect(legs[2]?.txHash).toBe("0xrefund");
  });

  it("a swap row carries null bridge fields (legs null) — swap shape unchanged", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 23, namespace: "kyberswap",
        product_type: "spot", trade_side: null, chain: "base",
        input_token: "USDC", input_amount: null, output_token: "WETH", output_amount: null,
        value_usd: null, capture_status: null, status: "pending",
        failure_code: null, chain_id: 8453, protocol: "kyberswap",
        tool_id: null, duration_ms: null,
        amount_in_raw: "5000000", amount_out_raw: "2000000000000000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: 18,
        from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
        chain_family: null, provider_order_id: null, provider_status: null, legs: null,
        tx_hash: null, created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items[0]).toMatchObject({
      productType: "spot",
      amountBasis: "requested", // swap rule, unchanged
      legs: null,
      fromChainId: null,
      providerOrderId: null,
    });
  });
});
