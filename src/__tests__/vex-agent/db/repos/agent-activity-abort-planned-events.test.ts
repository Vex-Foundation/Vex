/**
 * agent-activity repo — `abortPlannedEvents` unit tests (mocked pool).
 *
 * FIX2-SPINE round 2 (Codex final-review finding 3/C17): pins the CAS shape
 * an early-plan-abort finalize must have —
 *   - targets ONE execution's downstream rows (`protocol_execution_id = $1`)
 *     at or after `fromIndex` (`event_index >= $2`)
 *   - CAS-guarded: only `status = 'pending' AND tx_hash IS NULL` rows qualify
 *     (a row that already staged a hash is untouched — repair owns it)
 *   - finalizes to `definitively_failed` with the closed `failure_code`
 *     `'unknown'`
 *   - `failure_reason` passes the SAME repo-boundary sanitization
 *     (`redact()` + 500-char cap) as `failActivityEvent` (finding 9/C5) —
 *     callers cannot bypass it
 *   - returns every row it actually finalized (mapped), `[]` when none
 *     qualified — never throws for "nothing to abort"
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>>;

let mockQuery: QueryMock;
type SettlementInput = {
  readonly activityWrite: (client: unknown) => Promise<unknown>;
};
const mockSettleLinkedActivityRowsWith = vi.fn(
  async (client: unknown, input: SettlementInput) => input.activityWrite(client),
);

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
  // The agent-activity CAS writers now run inside a session-control-locked
  // transaction, so they reach the `…With` client variants. Routed to the SAME
  // fakes as their pool-level twins: the statement under test is identical, only
  // the connection it travels on changed.
  queryWith: (_c: unknown, sql: string, params?: unknown[]) => mockQuery(sql, params as never),
  queryOneWith: vi.fn(),
  executeWith: vi.fn(),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

vi.mock("@vex-agent/db/repos/agent-activity/linked-transaction-settlement.js", () => ({
  settleLinkedActivityRows: async (input: SettlementInput) => input.activityWrite({}),
  settleLinkedActivityRowsWith: (client: unknown, input: SettlementInput) =>
    mockSettleLinkedActivityRowsWith(client, input),
}));

const repo = await import("@vex-agent/db/repos/agent-activity.js");

function lastSql(): string {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![0];
}
function lastParams(): unknown[] {
  return mockQuery.mock.calls[mockQuery.mock.calls.length - 1]![1] ?? [];
}

function activityRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    protocol_execution_id: 42,
    event_index: 1,
    event_role: "allowance",
    record_version: 1,
    kind: "swap",
    protocol: "kyberswap",
    chain_id: 8453,
    chain_slug: "base",
    status: "definitively_failed",
    failure_code: "unknown",
    failure_reason: "not attempted: earlier swap reverted",
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
    tx_hash: null,
    from_address: null,
    nonce: null,
    wallet_address: "0xWALLET",
    session_id: "00000000-0000-4000-8000-000000000001",
    route_provenance: null,
    submit_attempted_at: null,
    broadcast_at: null,
    confirmed_at: null,
    last_checked_at: null,
    created_at: "2026-07-23T10:00:00.000Z",
    updated_at: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  resetMocks();
  mockSettleLinkedActivityRowsWith.mockClear();
});

describe("abortPlannedEvents", () => {
  it("CAS-targets the execution's downstream never-signed pending rows only", async () => {
    mockQuery.mockResolvedValueOnce([activityRow({ id: 2, event_index: 2 })]);
    await repo.abortPlannedEvents(42, 1, "not attempted: earlier allowance reverted");

    const sql = lastSql();
    expect(sql).toMatch(/protocol_execution_id\s*=\s*\$1/);
    expect(sql).toMatch(/event_index\s*>=\s*\$2/);
    expect(sql).toMatch(/status\s*=\s*'pending'/);
    expect(sql).toMatch(/tx_hash\s+IS\s+NULL/);
    expect(sql).toContain("SET status = 'definitively_failed'");
    expect(sql).toContain("failure_code = 'unknown'");

    const params = lastParams();
    expect(params[0]).toBe(42);
    expect(params[1]).toBe(1);
    expect(mockSettleLinkedActivityRowsWith).toHaveBeenCalledTimes(1);
  });

  it("binds the EXCLUSIVE upper bound so a single row can be aborted alone", async () => {
    // The fee-withholding path aborts `[feeLegIndex, feeLegIndex + 1)`: the fee
    // row and nothing else, because the logical `bridge_fill_expected` row sits
    // at the next index and its deposit reached the provider.
    mockQuery.mockResolvedValueOnce([activityRow({ id: 9, event_index: 3 })]);
    const rows = await repo.abortPlannedEvents(42, 3, "deposit proved less than the quoted principal", 4);

    const sql = lastSql();
    expect(sql).toMatch(/event_index\s*>=\s*\$2/);
    expect(sql).toMatch(/event_index\s*<\s*\$4/);
    expect(lastParams()).toEqual([
      42,
      3,
      "not attempted: deposit proved less than the quoted principal",
      4,
    ]);
    // Only the fee row came back: the row at `event_index` 4 is outside the
    // range the statement can touch, so it stays pending for the W4 sweep.
    expect(rows.map((row) => row.id)).toEqual([9]);
  });

  it("passes a NULL bound when no upper bound is given, so the range stays open", async () => {
    await repo.abortPlannedEvents(42, 1, "earlier leg reverted");
    expect(lastParams()[3]).toBeNull();
  });

  // THE LENGTH CAP WAS REMOVED, THE REDACTION WAS NOT (funded live audit,
  // 2026-08-18). The old 500-char slice cut a Morpho failure exactly where its
  // standing-allowance disclosure and remediation began, so the ledger and the
  // repair sweeps read a sentence stopping mid-word. `failure_reason` is TEXT,
  // and agent-facing content is never truncated; secrets are still stripped.
  it("sanitizes failure_reason the same way failActivityEvent does: redacted, and NEVER truncated", async () => {
    const longReason = "not attempted: earlier swap reverted - ".repeat(30); // > 500 chars
    await repo.abortPlannedEvents(7, 0, longReason);

    const params = lastParams();
    const boundReason = params[2] as string;
    expect(boundReason).toBe(`not attempted: ${longReason}`);
    expect(boundReason).not.toContain("[truncated]");
  });

  it("returns every finalized row, mapped", async () => {
    mockQuery.mockResolvedValueOnce([
      activityRow({ id: 5, event_index: 1 }),
      activityRow({ id: 6, event_index: 2 }),
    ]);
    const rows = await repo.abortPlannedEvents(42, 1, "not attempted: earlier allowance reverted");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).toBe(5);
    expect(rows[0]!.status).toBe("definitively_failed");
    expect(rows[0]!.failureCode).toBe("unknown");
    expect(rows[1]!.id).toBe(6);
    expect(mockSettleLinkedActivityRowsWith).toHaveBeenCalledTimes(2);
  });

  it("returns [] (never throws) when nothing qualifies", async () => {
    mockQuery.mockResolvedValueOnce([]);
    await expect(repo.abortPlannedEvents(999, 0, "not attempted: earlier swap ambiguous")).resolves.toEqual([]);
  });
});
