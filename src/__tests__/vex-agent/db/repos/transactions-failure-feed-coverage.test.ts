/**
 * Compatibility feed — failure-half CATEGORY coverage (Agent Scan plan §4.3
 * / task E: "the failure feed still surfaces failed swap/bridge/perps/
 * prediction attempts"; FIX-SPINE round 1, finding 1/2/16/C9, corrected the
 * feed's actual filtering AND this test's premises).
 *
 * `transactions-failure-tools.test.ts` pins the ALLOWLIST derivation
 * (MUTATION_MATRIX + LEGACY_TOOL_PRODUCTS → product); `transactions.test.ts`
 * pins the SQL shape of the unified feed generically. This file closes two
 * remaining gaps:
 *   (a) a representative, CURRENTLY-LIVE tool from every surviving
 *       trade-impacting category round-trips through `getTransactions()`'s
 *       failure half with the correct derived `productType`;
 *   (b) the failure-half SQL TEXT itself (not a mocked row's premise) really
 *       contains the two conditions that make it correct (`execution_status
 *       = 'failed'`, the `NOT EXISTS (... agent_activity ...)` guard) — round
 *       1's version of this file asserted a row shape the REAL SQL could
 *       never have selected (a deleted tool with no allowlist entry at all);
 *       this version asserts against the REAL SQL string AND against row
 *       shapes that are honest about what the query's OWN WHERE clause
 *       would/would not admit.
 *
 * A regression here (a category silently losing its allowlist membership,
 * the mapper mis-deriving its product, or the feed showing an in-flight
 * intent / a double-counted agent_activity execution as a legacy failure)
 * would violate the "failed AND pending transactions are recorded and
 * shown, exactly once" product requirement (plan §1.7).
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
const { FAILURE_TOOL_PRODUCTS } = await import("@vex-agent/db/repos/transactions-failure-tools.js");

const ADDRS = ["0xEVM"];
const SESSION = "00000000-0000-4000-8000-000000000009";

/** A row shaped exactly like what the REAL 44-column failure-half SELECT produces (transactions.ts). */
function failureRow(toolId: string, id: number): Record<string, unknown> {
  return {
    source: "failure", source_rank: 2, id, namespace: "test",
    product_type: null, trade_side: null, chain: null,
    input_token: null, input_amount: null, output_token: null, output_amount: null,
    value_usd: null, capture_status: null, status: "failed",
    failure_code: null, failure_reason: null, chain_id: null, protocol: null,
    tool_id: toolId, duration_ms: 500,
    protocol_execution_id: id, event_index: null, event_role: null,
    token_in_address: null, token_in_symbol: null, token_in_decimals: null,
    token_out_address: null, token_out_symbol: null, token_out_decimals: null,
    amount_in_human: null, amount_in_raw: null, amount_out_human: null, amount_out_raw: null,
    executed_amount_in_human: null, executed_amount_in_raw: null,
    executed_amount_out_human: null, executed_amount_out_raw: null,
    usd_in_est: null, usd_out_est: null, usd_fee_est: null, usd_source: null,
    tx_hash: null, created_at: "2026-07-22T10:00:00.000000Z",
    cursor_ts: "2026-07-22T10:00:00.000000Z",
  };
}

function lastSql(): string {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![0];
}

beforeEach(() => {
  resetMocks();
});

// One representative toolId per surviving trade-impacting category — a mix
// of LIVE (current matrix) and LEGACY (deleted-tool history, FIX-SPINE C9)
// entries. If a category loses its allowlist membership (accidental
// deletion from either source) or the derived product drifts,
// `FAILURE_TOOL_PRODUCTS.get` catches it here too — but the real point of
// this suite is the round-trip through `getTransactions`.
const CATEGORY_TOOLS: ReadonlyArray<readonly [string, string]> = [
  // Live
  ["kyberswap.swap.execute", "spot"],
  ["uniswap.swap.execute", "spot"],
  ["solana.swap.execute", "spot"],
  ["solana.predict.buy", "prediction"],
  ["khalani.bridge", "bridge"],
  ["relay.bridge", "bridge"],
  // Agent Scan Phase 3/W5 (migration 049): lend joined TRANSACTION_PRODUCTS —
  // a failed Jupiter Lend deposit/withdraw attempt now round-trips too.
  ["solana.lend.deposit", "lend"],
  ["solana.lend.withdraw", "lend"],
  // Legacy (deleted tools whose HISTORY must still surface — C9)
  ["kyberswap.swap.sell", "spot"],
  ["kyberswap.limitOrder.create", "order"],
  ["kyberswap.zap.in", "lp"],
  ["polymarket.clob.buy", "prediction"],
  // Agent Scan Phase 3 removed the whole Hyperliquid protocol — perps history
  // must still surface via LEGACY_TOOL_PRODUCTS, same as the other deleted tools above.
  ["hyperliquid.perp.open", "perps"],
];

describe("compatibility feed — failure half surfaces every surviving + legacy trade category", () => {
  it.each(CATEGORY_TOOLS)("a failed %s attempt round-trips with productType %s", async (toolId, expectedProduct) => {
    expect(FAILURE_TOOL_PRODUCTS.get(toolId), `${toolId} must be in the allowlist`).toBe(expectedProduct);

    mockQuery.mockResolvedValueOnce([failureRow(toolId, 1)]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });

    expect(res.items).toHaveLength(1);
    const row = res.items[0]!;
    expect(row.source).toBe("failure");
    expect(row.status).toBe("failed");
    expect(row.toolId).toBe(toolId);
    expect(row.productType).toBe(expectedProduct);
  });

  it("a toolId in NEITHER the live matrix NOR the legacy map maps to 'unknown' (closed-set fallback, not a deny-list)", async () => {
    const neverMapped = "some.never.tracked.tool";
    expect(FAILURE_TOOL_PRODUCTS.has(neverMapped)).toBe(false);

    // Honest about what this represents: the real SQL's `tool_id = ANY($allowlist)`
    // filter would NEVER select a row for a toolId outside the allowlist — this
    // row could only reach the mapper if the allowlist ever silently included
    // something undefined in FAILURE_TOOL_PRODUCTS (a genuine bug). The mapper's
    // fallback is defense-in-depth for exactly that bug class, not a claim that
    // production SQL would surface this today.
    mockQuery.mockResolvedValueOnce([failureRow(neverMapped, 3)]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items[0]!.productType).toBe("unknown");
  });

  it("the generated SQL requires execution_status='failed', NOT `success=false` alone (finding 1/C9)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const sql = lastSql();
    expect(sql).toContain("execution_status = 'failed'");
    // The old, insufficient filter must be gone from the failure half.
    const failureHalf = sql.split("FROM protocol_executions")[1] ?? "";
    expect(failureHalf).not.toMatch(/\bsuccess\s*=\s*false\b/);
  });

  it("the generated SQL excludes any execution already represented in agent_activity (finding 2/C9)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const sql = lastSql();
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = protocol_executions.id)");
  });
});
