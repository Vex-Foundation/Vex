/**
 * transactions repo — Agent Scan Phase 3/W5 (migration 049) unit tests
 * (mocked pool), split out of `transactions.test.ts` by domain under test
 * (same pattern as Cards F1/W0-C: move-only, no assertion changes, no
 * coverage loss) once the parent file crossed the repo's 500-line cap.
 *
 * Pins the R5 display-matrix corrections layered onto the existing C20/Q2
 * rules (see `transactions.test.ts` for the base swap/bridge coverage this
 * file does not repeat):
 *   - `productType` 'lend'/'prediction' map to `kind='lend'`/`kind='prediction'`
 *     on the agent_activity half (migration 049); 'order' still has no
 *     agent_activity representation;
 *   - a CONFIRMED row without decoder-proven executed legs falls back to the
 *     quote, labelled `estimated` (the "confirmed implies executed"
 *     assumption held for swaps only because the sweep never confirms a swap
 *     without both legs decoded — lend/prediction confirmations are not
 *     guaranteed decoder-proven);
 *   - lend/prediction rows are ONE role per on-chain tx (no bridge-style
 *     logical/leg fan-out) and carry REAL token mints on tokenIn/tokenOut
 *     (never a position/market pubkey — the token-history eligibility
 *     contract K8 reads);
 *   - `chainFamily` is surfaced for ANY agent_activity row, not bridge-only;
 *   - the failure half's NOT EXISTS dedup guard stays present for the new
 *     productTypes, so a converted lend/prediction failure surfaces via
 *     agent_activity exactly once, never doubled with the legacy failure half.
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

// ── filters (migration 049, W5) ───────────────────────────────────────────

describe("filters — lend/prediction (migration 049, W5)", () => {
  it("productType='order' (no agent_activity representation either) still excludes the half", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "order", limit: 20 });
    const activityHalf = lastSql().split("FROM proj_activity")[0]!;
    expect(activityHalf).toContain("FALSE");
  });

  it("productType='lend' includes agent_activity via kind='lend' (migration 049, W5)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "lend", limit: 20 });
    const activityHalf = lastSql().split("FROM proj_activity")[0]!;
    expect(activityHalf).not.toContain("FALSE");
    expect(activityHalf).toContain("kind = 'lend'");
  });

  it("productType='prediction' includes agent_activity via kind='prediction' (migration 049, W5)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "prediction", limit: 20 });
    const activityHalf = lastSql().split("FROM proj_activity")[0]!;
    expect(activityHalf).not.toContain("FALSE");
    expect(activityHalf).toContain("kind = 'prediction'");
  });
});

// ── W5/R5 amount correction ────────────────────────────────────────────────

describe("agent_activity display amount — W5/R5 correction", () => {
  it("a CONFIRMED row without decoder-proven executed legs falls back to the quote, labelled 'estimated' — never blanked", async () => {
    // A lend/prediction confirmation is not guaranteed decoder-proven (unlike
    // the swap sweep's both-legs-required invariant) — the old code would have
    // shown NOTHING here (it assumed confirmed ⇒ executed data present).
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 13, namespace: "jupiter",
        product_type: "lend", trade_side: null, chain: "solana",
        input_token: "USDC", input_amount: null, output_token: null, output_amount: null,
        value_usd: null, capture_status: null, status: "confirmed",
        failure_code: null, chain_id: 20011000000, protocol: "jupiter",
        tool_id: null, duration_ms: null,
        amount_in_raw: "5000000", amount_out_raw: null,
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: null,
        tx_hash: "sig123", created_at: "2026-07-24T10:00:00.000000Z",
        cursor_ts: "2026-07-24T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.amountBasis).toBe("estimated");
    expect(row.inputAmount).toBe("5"); // the quote, since no executed data was decoded
  });
});

// ── lend/prediction feed (Agent Scan Phase 3/W5, migration 049) ──────────

describe("agent_activity lend/prediction feed (R5)", () => {
  it("a lend row: product_type='lend', ONE role per tx (no legs/bridge fields), real mint on tokenIn/tokenOut", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 30, namespace: "jupiter",
        product_type: "lend", trade_side: null, chain: "solana",
        input_token: "USDC", input_amount: null, output_token: null, output_amount: null,
        value_usd: "5.0", capture_status: null, status: "confirmed",
        failure_code: null, chain_id: 20011000000, protocol: "jupiter",
        tool_id: null, duration_ms: null, event_role: "lend_deposit",
        token_in_address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", token_in_symbol: "USDC",
        token_out_address: null, token_out_symbol: null,
        amount_in_raw: "5000000", amount_out_raw: null,
        executed_amount_in_raw: "5000000", executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: null,
        chain_family: "solana",
        from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
        provider_order_id: null, provider_status: null, legs: null,
        tx_hash: "sigLend1", created_at: "2026-07-24T10:00:00.000000Z",
        cursor_ts: "2026-07-24T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.productType).toBe("lend");
    expect(row.eventRole).toBe("lend_deposit");
    expect(row.amountBasis).toBe("executed");
    expect(row.inputAmount).toBe("5");
    // Non-bridge product: bridge-only route/leg fields stay null.
    expect(row.legs).toBeNull();
    expect(row.fromChainId).toBeNull();
    expect(row.providerOrderId).toBeNull();
    // A real SPL mint — never a position/market pubkey (R5 token-history contract).
    expect(row.tokenInAddress).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("a prediction row (pending buy): product_type='prediction', amountBasis='requested' (unchanged pending rule)", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 31, namespace: "jupiter",
        product_type: "prediction", trade_side: null, chain: "solana",
        input_token: "USDC", input_amount: null, output_token: null, output_amount: null,
        value_usd: null, capture_status: null, status: "pending",
        failure_code: null, chain_id: 20011000000, protocol: "jupiter",
        tool_id: null, duration_ms: null, event_role: "predict_buy",
        amount_in_raw: "5500000", amount_out_raw: null,
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: null,
        chain_family: "solana",
        from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
        provider_order_id: null, provider_status: null, legs: null,
        tx_hash: "sigPredict1", created_at: "2026-07-24T10:00:00.000000Z",
        cursor_ts: "2026-07-24T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.productType).toBe("prediction");
    expect(row.eventRole).toBe("predict_buy");
    expect(row.amountBasis).toBe("requested");
    expect(row.inputAmount).toBe("5.5");
  });

  it("chainFamily is surfaced for a non-bridge Solana row (R5 — no longer bridge-gated)", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 32, namespace: "jupiter",
        product_type: "spot", trade_side: null, chain: "solana",
        input_token: "SOL", input_amount: null, output_token: "USDC", output_amount: null,
        value_usd: null, capture_status: null, status: "pending",
        failure_code: null, chain_id: 20011000000, protocol: "jupiter",
        tool_id: null, duration_ms: null,
        amount_in_raw: "1000000000", amount_out_raw: "150000000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 9, token_out_decimals: 6,
        chain_family: "solana",
        from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
        provider_order_id: null, provider_status: null, legs: null,
        tx_hash: "sigSwap1", created_at: "2026-07-24T10:00:00.000000Z",
        cursor_ts: "2026-07-24T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.productType).toBe("spot");
    expect(row.chainFamily).toBe("solana");
  });

  it("chainFamily stays null for a pre-W5 EVM swap row that never set it (backward compatible)", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 33, namespace: "kyberswap",
        product_type: "spot", trade_side: null, chain: "base",
        input_token: "USDC", input_amount: null, output_token: "WETH", output_amount: null,
        value_usd: null, capture_status: null, status: "pending",
        failure_code: null, chain_id: 8453, protocol: "kyberswap",
        tool_id: null, duration_ms: null,
        amount_in_raw: "5000000", amount_out_raw: "2000000000000000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: 18,
        chain_family: null,
        from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
        provider_order_id: null, provider_status: null, legs: null,
        tx_hash: null, created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items[0]).toMatchObject({ chainFamily: null });
  });

  it("the NOT EXISTS dedup guard stays present for productType='lend'/'prediction' — a converted failure surfaces via agent_activity ONLY, never twice", async () => {
    // The guard is unconditional in buildFailureHalf (not productType-gated),
    // so a converted lend/prediction mutation's PRE-agent_activity failure
    // rows never double up with its post-conversion agent_activity row —
    // pin it explicitly for the two W5 products, not just the default query.
    for (const productType of ["lend", "prediction"]) {
      await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType, limit: 20 });
      const sql = lastSql();
      expect(sql).toContain(
        "NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = protocol_executions.id)",
      );
    }
  });

  it("a converted prediction failure appears ONCE via agent_activity, not ALSO via the failure half (dedup, R5)", async () => {
    // Simulates the real invariant the SQL's NOT EXISTS guard enforces: once
    // an agent_activity row exists for an execution, the SAME execution's
    // protocol_executions row is excluded from the result set entirely — the
    // mock only returns the agent_activity row, exactly as the real SQL would.
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 40, namespace: "jupiter",
        product_type: "prediction", trade_side: null, chain: "solana",
        input_token: "USDC", input_amount: null, output_token: null, output_amount: null,
        value_usd: null, capture_status: null, status: "definitively_failed",
        failure_code: "solana_signature_expired", chain_id: 20011000000, protocol: "jupiter",
        tool_id: null, duration_ms: null, event_role: "predict_buy",
        protocol_execution_id: 777,
        amount_in_raw: "5000000", amount_out_raw: null,
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: null,
        chain_family: "solana",
        from_chain_id: null, from_chain_slug: null, to_chain_id: null, to_chain_slug: null,
        provider_order_id: null, provider_status: null, legs: null,
        tx_hash: "sigFailed1", created_at: "2026-07-24T10:00:00.000000Z",
        cursor_ts: "2026-07-24T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.source).toBe("agent_activity");
    expect(res.items[0]!.protocolExecutionId).toBe(777);
  });
});
