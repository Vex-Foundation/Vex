/**
 * transactions repo — Stage 9 unit tests (mocked pool). Agent Scan (plan
 * §4.1/§11.1) added a THIRD half — `agent_activity` (sourceRank=0) — ahead of
 * the legacy success (sourceRank=1) and failure (sourceRank=2) halves.
 *
 * The bridge (migration 045) product_type/legs/route mapping tests and the
 * lend/prediction (migration 049) tests live in this file's siblings,
 * `transactions-bridge-feed.test.ts` and `transactions-lend-prediction.test.ts`
 * respectively — split out by domain under test (Cards K7/C5) once this file
 * crossed the repo's 500-line cap; no assertion changes, no coverage loss.
 *
 * Pins the SQL shape + params and the keyset/union/exposure invariants:
 *   - agent_activity is ALWAYS present (wallet-scoped, like success — NOT
 *     session-gated the way the legacy failure half is)
 *   - sessionId missing → agent_activity + success only (failure half
 *     omitted, NOT leaked)
 *   - productType filters product_type (success), the failure-tool allowlist
 *     (failure), and excludes agent_activity entirely for a non-"spot" filter
 *     — NEVER trade_side
 *   - txHash filters ALL THREE halves
 *   - the SQL NEVER selects params / result / trade_capture
 *   - keyset predicate present on each half; hasMore via limit+1; nextCursor
 *     minted from the last KEPT row's microsecond cursor_ts
 *   - tie ordering stable across all three sources (source_rank tie-break) —
 *     the ORDER BY carries source_rank between created_at and id
 *   - returned rows carry no params/result; failure rows carry no economics
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
const { encodeCursor } = await import("@vex-agent/db/repos/transactions-cursor.js");
const { failureToolsForProduct } = await import("@vex-agent/db/repos/transactions-failure-tools.js");

const ADDRS = ["0xEVM", "SOL"];
const SESSION = "00000000-0000-4000-8000-000000000001";

function lastSql(): string {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![0];
}
function lastParams(): unknown[] {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![1] ?? [];
}

beforeEach(() => {
  resetMocks();
});

// ── data-exposure invariant ───────────────────────────────────────────────

describe("data-exposure invariant", () => {
  it("NEVER selects params, result, or trade_capture", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const sql = lastSql();
    // Word-boundary checks so e.g. a hypothetical column containing "result"
    // would still trip — but plainly, none of these tokens should appear.
    expect(sql).not.toMatch(/\bparams\b/);
    expect(sql).not.toMatch(/\bresult\b/);
    expect(sql).not.toMatch(/\btrade_capture\b/);
  });

  it("failure rows on the output carry no economics and no params/result field", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "failure", source_rank: 2, id: 7, namespace: "solana",
        product_type: null, trade_side: null, chain: null,
        input_token: null, input_amount: null, output_token: null, output_amount: null,
        value_usd: null, capture_status: null, status: "failed",
        tool_id: "solana.swap.execute", duration_ms: 1200,
        tx_hash: null, created_at: "2026-06-04T10:00:00.000000Z",
        cursor_ts: "2026-06-04T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.source).toBe("failure");
    expect(row.productType).toBe("spot"); // derived from the allowlist
    expect(row.status).toBe("failed");
    expect(row.toolId).toBe("solana.swap.execute");
    expect("params" in row).toBe(false);
    expect("result" in row).toBe(false);
    // No economics fields on a failure row.
    for (const econ of ["valueUsd", "inputToken", "outputToken", "tradeSide", "captureStatus"] as const) {
      expect(row[econ]).toBeUndefined();
    }
  });

  it("agent_activity rows carry status/failureCode/chainId/protocol additively", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 3, namespace: "kyberswap",
        product_type: "spot", trade_side: null, chain: "base",
        input_token: "USDC", input_amount: "10", output_token: "WETH", output_amount: "0.003",
        value_usd: "10.5", capture_status: null, status: "pending",
        failure_code: null, chain_id: 8453, protocol: "kyberswap",
        tool_id: null, duration_ms: null,
        tx_hash: "0xhash", created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.source).toBe("agent_activity");
    expect(row.status).toBe("pending");
    expect(row.failureCode).toBeNull();
    expect(row.chainId).toBe(8453);
    expect(row.protocol).toBe("kyberswap");
    expect(row.txHash).toBe("0xhash");
  });
});

// ── FIX2-SPINE C20: confirmed rows never display quote-time amounts ────────

describe("agent_activity display amount (FIX2-SPINE C20, finding 5)", () => {
  it("SQL no longer COALESCEs human amounts on the agent_activity half — NULL placeholders instead", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const sql = lastSql();
    const activityHalf = sql.split("FROM proj_activity")[0]!;
    expect(activityHalf).not.toMatch(/COALESCE\(executed_amount_in_human/);
    expect(activityHalf).not.toMatch(/COALESCE\(executed_amount_out_human/);
    expect(activityHalf).toContain("NULL::text AS input_amount");
    expect(activityHalf).toContain("NULL::text AS output_amount");
  });

  it("confirmed row: inputAmount/outputAmount derive from EXECUTED raw + decimals, never the quote", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 10, namespace: "kyberswap",
        product_type: "spot", trade_side: null, chain: "base",
        input_token: "USDC", input_amount: null, output_token: "WETH", output_amount: null,
        value_usd: null, capture_status: null, status: "confirmed",
        failure_code: null, chain_id: 8453, protocol: "kyberswap",
        tool_id: null, duration_ms: null,
        // Requested (quote-time) legs deliberately DIFFER from executed — a
        // confirmed row must never surface the quote as if it were truth.
        amount_in_raw: "5000000", amount_out_raw: "2000000000000000",
        executed_amount_in_raw: "4990000", executed_amount_out_raw: "1987000000000000",
        token_in_decimals: 6, token_out_decimals: 18,
        tx_hash: "0xhash", created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.amountBasis).toBe("executed");
    expect(row.inputAmount).toBe("4.99"); // from executed_amount_in_raw, NOT the "5" quote
    expect(row.outputAmount).toBe("0.001987"); // from executed_amount_out_raw
  });

  it("pending row: inputAmount/outputAmount fall back to the REQUESTED quote, labelled", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 11, namespace: "kyberswap",
        product_type: "spot", trade_side: null, chain: "base",
        input_token: "USDC", input_amount: null, output_token: "WETH", output_amount: null,
        value_usd: null, capture_status: null, status: "pending",
        failure_code: null, chain_id: 8453, protocol: "kyberswap",
        tool_id: null, duration_ms: null,
        amount_in_raw: "5000000", amount_out_raw: "2000000000000000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: 18,
        tx_hash: null, created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const row = res.items[0];
    expect(row.amountBasis).toBe("requested");
    expect(row.inputAmount).toBe("5");
    expect(row.outputAmount).toBe("0.002");
  });

  it("definitively_failed row: no display amount at all — never echoes the never-settled quote", async () => {
    mockQuery.mockResolvedValueOnce([
      {
        source: "agent_activity", source_rank: 0, id: 12, namespace: "kyberswap",
        product_type: "spot", trade_side: null, chain: "base",
        input_token: "USDC", input_amount: null, output_token: "WETH", output_amount: null,
        value_usd: null, capture_status: null, status: "definitively_failed",
        failure_code: "mined_revert", chain_id: 8453, protocol: "kyberswap",
        tool_id: null, duration_ms: null,
        amount_in_raw: "5000000", amount_out_raw: "2000000000000000",
        executed_amount_in_raw: null, executed_amount_out_raw: null,
        token_in_decimals: 6, token_out_decimals: 18,
        tx_hash: "0xhash", created_at: "2026-07-22T10:00:00.000000Z",
        cursor_ts: "2026-07-22T10:00:00.000000Z",
      },
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(res.items[0]).toMatchObject({
      amountBasis: null,
      inputAmount: null,
      outputAmount: null,
    });
  });

  // W5/R5's "confirmed without decoder-proven executed legs → estimated"
  // correction is pinned in `transactions-lend-prediction.test.ts` (this
  // file's sibling — kept out of here to stay under the repo's 500-line cap).
});

// The bridge (Agent Scan Phase 2, migration 045) product_type/legs/route
// mapping tests are pinned in `transactions-bridge-feed.test.ts` (this file's
// sibling — moved out by Card C5 to stay under the repo's 500-line cap).

// ── session scoping ────────────────────────────────────────────────────────

describe("session scoping", () => {
  it("sessionId present → emits ALL THREE halves (UNION ALL)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const sql = lastSql();
    expect(sql).toContain("FROM agent_activity");
    expect(sql).toContain("FROM proj_activity");
    expect(sql).toContain("FROM protocol_executions");
    expect(sql).toContain("UNION ALL");
    // FIX-SPINE round 1 (finding 1/C9): NOT `success = false` alone — a
    // freshly-created intent row also has success=false until it completes.
    expect(sql).toContain("execution_status = 'failed'");
    expect(sql).not.toMatch(/\bsuccess\s*=\s*false\b/);
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM agent_activity aa WHERE aa.protocol_execution_id = protocol_executions.id)");
    expect(lastParams()).toContain(SESSION);
  });

  it("sessionId null → agent_activity + success halves only (failure omitted, not leaked)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: null, limit: 20 });
    const sql = lastSql();
    expect(sql).toContain("FROM agent_activity");
    expect(sql).toContain("FROM proj_activity");
    expect(sql).not.toContain("FROM protocol_executions");
    // The two remaining halves are still combined by exactly one UNION ALL.
    expect(sql.split("\n    UNION ALL\n").length).toBe(2);
    expect(sql).not.toContain("execution_status = 'failed'");
  });

  it("sessionId empty string → agent_activity + success halves only", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: "", limit: 20 });
    expect(lastSql()).not.toContain("FROM protocol_executions");
  });

  it("agent_activity is wallet-scoped, NOT session-scoped — present even without a session", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: null, limit: 20 });
    const sql = lastSql();
    // Anchor on the MAIN half's bare `FROM agent_activity\n` — the legs
    // subquery (`FROM agent_activity leg`) and the legacy NOT EXISTS
    // (`FROM agent_activity aa`) must not satisfy this split.
    const activityHalf = sql.split("FROM agent_activity\n")[1]!;
    expect(activityHalf).toMatch(/wallet_address = ANY\(\$\d+::text\[\]\)/);
  });

  it("empty wallet set → no query, empty result (fail-closed)", async () => {
    const res = await repo.getTransactions({ addresses: [], sessionId: SESSION, limit: 20 });
    expect(mockQuery).not.toHaveBeenCalled();
    expect(res.items).toEqual([]);
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
    expect(res.failuresScope).toBe("session");
  });
});

// ── filters ────────────────────────────────────────────────────────────────

describe("filters", () => {
  it("productType='spot' includes agent_activity + filters product_type (success) + the failure allowlist", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "spot", limit: 20 });
    const sql = lastSql();
    const params = lastParams();
    expect(sql).toContain("FROM agent_activity");
    const activityHalf = sql.split("FROM proj_activity")[0]!;
    expect(activityHalf).not.toContain("FALSE");
    // Success half filters product_type.
    expect(sql).toContain("product_type = $");
    expect(params).toContain("spot");
    // Failure half filters by the DERIVED-PRODUCT allowlist, never trade_side.
    expect(sql).not.toMatch(/trade_side\s*=/);
    const spotTools = failureToolsForProduct("spot");
    const hasAllowlistParam = params.some(
      (p) => Array.isArray(p) && p.length === spotTools.length && spotTools.every((t) => p.includes(t)),
    );
    expect(hasAllowlistParam, "spot failure-tool allowlist bound as a param").toBe(true);
  });

  it("productType='bridge' includes agent_activity via kind='bridge' (NOT excluded) and only the logical row", async () => {
    // Agent Scan Phase 2 (migration 045): 'bridge' now maps to `kind='bridge'`
    // — it must NOT exclude the half (the pre-045 behavior). Only the LOGICAL
    // row surfaces (its per-leg siblings ride `legs[]`).
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "bridge", limit: 20 });
    const sql = lastSql();
    const activityHalf = sql.split("FROM proj_activity")[0]!;
    expect(activityHalf).not.toContain("FALSE");
    expect(activityHalf).toContain("kind = 'bridge'");
    // Bridges collapse to the logical row; swaps/lend/prediction/launch still
    // emit every row (one role per on-chain tx — no logical/leg split, R5).
    expect(activityHalf).toContain(
      "(kind = 'swap' OR kind = 'lend' OR kind = 'prediction' OR kind = 'wrap' OR kind = 'yield' OR kind = 'launch' OR kind = 'claim' OR kind = 'transfer' OR kind = 'transaction' OR event_role = 'bridge_fill_expected')",
    );
  });

  it("a productType with NO agent_activity representation (perps) still excludes the half (FALSE, no param bind)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "perps", limit: 20 });
    const sql = lastSql();
    const activityHalf = sql.split("FROM proj_activity")[0]!;
    expect(activityHalf).toContain("FALSE");
  });

  // productType='lend'/'prediction'/'order' mapping (migration 049, W5) is
  // pinned in `transactions-lend-prediction.test.ts` (this file's sibling —
  // kept out of here to stay under the repo's 500-line cap).

  it("productType='spot' maps to kind='swap' on the agent_activity half", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, productType: "spot", limit: 20 });
    const activityHalf = lastSql().split("FROM proj_activity")[0]!;
    expect(activityHalf).toContain("kind = 'swap'");
    expect(activityHalf).not.toContain("FALSE");
  });

  it("txHash filters ALL THREE halves", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, txHash: "0xDEAD", limit: 20 });
    const sql = lastSql();
    // agent_activity filters the raw tx_hash column directly (no jsonb path).
    expect(sql).toContain("tx_hash = $");
    // success + failure both filter via external_refs->>'txHash'.
    const occurrences = sql.split("external_refs->>'txHash' = $").length - 1;
    expect(occurrences).toBe(2);
    // The agent_activity half binds the hash param ONCE (reused across the
    // own-hash + sibling-EXISTS disjunct); success + failure bind it once each.
    expect(lastParams().filter((p) => p === "0xDEAD")).toHaveLength(3);
  });

  it("txHash lookup is LEG-AWARE on the agent_activity half — a bridge matches by ANY sibling leg hash (m7)", async () => {
    // Codex FIX-ROUND-1 m7: `agent_scan txHash=<deposit|refund|extra-fill>` must
    // return the bridge's LOGICAL row (legs included), not miss it because the
    // logical row's own tx_hash is only the FILL hash. The half matches the
    // logical row when ANY leg of the same execution carries the hash, gated on
    // the logical role so a swap leg's own-hash match is never widened.
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, txHash: "0xDEP", limit: 20 });
    const activityHalf = lastSql().split("FROM proj_activity")[0]!;
    expect(activityHalf).toContain("event_role = 'bridge_fill_expected' AND EXISTS (");
    expect(activityHalf).toContain(
      "sib.protocol_execution_id = agent_activity.protocol_execution_id",
    );
    expect(activityHalf).toContain("sib.tx_hash = $");
    // The own-hash disjunct still covers swap legs (each is its own feed row).
    expect(activityHalf).toContain("tx_hash = $");
  });

  it("namespace filters ALL THREE halves", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, namespace: "solana", limit: 20 });
    const sql = lastSql();
    // agent_activity filters via its `protocol` column; success/failure via `namespace`.
    expect(sql).toContain("protocol = $");
    expect(sql.split("namespace = $").length - 1).toBe(2);
  });
});

// ── ordering + keyset pagination ─────────────────────────────────────────────

describe("ordering + keyset", () => {
  it("ORDER BY carries source_rank between created_at and id (stable cross-source tie-break)", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    expect(lastSql()).toContain("ORDER BY created_at DESC, source_rank DESC, id DESC");
  });

  it("first page (no cursor) emits NO keyset predicate and LIMIT limit+1", async () => {
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 20 });
    const sql = lastSql();
    expect(sql).not.toContain("::timestamptz");
    // limit+1 bound as the last param.
    const params = lastParams();
    expect(params[params.length - 1]).toBe(21);
  });

  it("with a cursor, each half carries the strict-past keyset predicate (ranks 0/1/2)", async () => {
    const cursor = { cursorTs: "2026-06-04T10:00:00.500000Z", sourceRank: 1 as const, id: 99 };
    await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, cursor, limit: 20 });
    const sql = lastSql();
    // Strict-past tuple comparison present (specialised per half with constant rank).
    expect(sql).toContain("created_at < $1::timestamptz");
    // All three halves reference the keyset (agent_activity rank 0, success rank 1, failure rank 2).
    expect(sql).toContain("0 < $2::int");
    expect(sql).toContain("1 < $2::int");
    expect(sql).toContain("2 < $2::int");
    expect(sql).toContain("id < $3::int");
    const params = lastParams();
    expect(params[0]).toBe("2026-06-04T10:00:00.500000Z");
    expect(params[1]).toBe(1);
    expect(params[2]).toBe(99);
  });

  it("hasMore=false when rows ≤ limit; nextCursor null", async () => {
    mockQuery.mockResolvedValueOnce([row({ id: 1 }), row({ id: 2 })]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 5 });
    expect(res.hasMore).toBe(false);
    expect(res.nextCursor).toBeNull();
    expect(res.items).toHaveLength(2);
  });

  it("hasMore=true via limit+1; nextCursor minted from the LAST KEPT row", async () => {
    // limit 2 → fetch 3; the 3rd is the +1 sentinel and is dropped.
    mockQuery.mockResolvedValueOnce([
      row({ id: 10, source_rank: 0, cursor_ts: "2026-06-04T10:00:02.000000Z" }),
      row({ id: 9, source_rank: 0, cursor_ts: "2026-06-04T10:00:01.000000Z" }),
      row({ id: 8, source_rank: 0, cursor_ts: "2026-06-04T10:00:00.000000Z" }), // +1 sentinel
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 2 });
    expect(res.hasMore).toBe(true);
    expect(res.items).toHaveLength(2);
    // nextCursor encodes the LAST KEPT row (id 9, ts ...01), NOT the sentinel.
    expect(res.nextCursor).toBe(
      encodeCursor({ cursorTs: "2026-06-04T10:00:01.000000Z", sourceRank: 0, id: 9 }),
    );
  });

  it("tie ordering: an agent_activity (rank 0) and success (rank 1) at equal created_at keep a stable cursor", async () => {
    mockQuery.mockResolvedValueOnce([
      row({ id: 5, source: "success", source_rank: 1, cursor_ts: "2026-06-04T10:00:00.000000Z" }),
      row({ id: 5, source: "agent_activity", source_rank: 0, cursor_ts: "2026-06-04T10:00:00.000000Z" }),
      row({ id: 4, source: "agent_activity", source_rank: 0, cursor_ts: "2026-06-04T10:00:00.000000Z" }), // sentinel
    ]);
    const res = await repo.getTransactions({ addresses: ADDRS, sessionId: SESSION, limit: 2 });
    expect(res.hasMore).toBe(true);
    // last kept row is the agent_activity rank-0 id-5 (the equal-created_at tie-break landed it after success).
    expect(res.nextCursor).toBe(
      encodeCursor({ cursorTs: "2026-06-04T10:00:00.000000Z", sourceRank: 0, id: 5 }),
    );
  });
});

// ── helpers ──────────────────────────────────────────────────────────────────

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    source: "success", source_rank: 1, id: 1, namespace: "solana",
    product_type: "spot", trade_side: "buy", chain: "solana",
    input_token: "USDC", input_amount: "10", output_token: "BONK", output_amount: "1000",
    value_usd: "10.5", capture_status: "executed", status: null,
    failure_code: null, chain_id: null, protocol: null,
    tool_id: null, duration_ms: null,
    tx_hash: "0xabc", created_at: "2026-06-04T10:00:00.000000Z",
    cursor_ts: "2026-06-04T10:00:00.000000Z",
    ...overrides,
  };
}
