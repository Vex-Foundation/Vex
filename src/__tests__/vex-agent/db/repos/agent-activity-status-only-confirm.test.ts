/**
 * `confirmActivityEventStatusOnly` — the repair-sweep-owned CAS finalizer
 * (owner decree 2026-07-30, status-only pending-transaction resolver).
 *
 * The sweeps no longer decode settlements, so they can prove a transaction
 * SUCCEEDED without being able to prove WHAT it moved. This finalizer is the
 * one deliberate bypass of the strict amount guards: it flips
 * `pending -> confirmed` and writes NO amount column at all — `executed_*`
 * stay NULL and Agent Scan labels the quoted amount "estimated" instead of
 * dressing a quote up as a settlement.
 *
 * Pinned here:
 *   - the CAS predicate is still `WHERE id = $1 AND status = 'pending'` and the
 *     `{applied,row}` contract is identical to every sibling finalizer;
 *   - the UPDATE touches `status`/`confirmed_at`/`updated_at` and nothing else
 *     — no `executed_amount_*` column may appear in the statement;
 *   - it is reachable through the `agent-activity.ts` facade, not only the
 *     `swap-lifecycle.ts` implementation module.
 *
 * ALSO pins the wrap/unwrap guard added to the STRICT `confirmActivityEvent`:
 * migration 061 drops `agent_activity_confirmed_wrap_has_executed_legs`, so
 * without a repo-level guard `wrap`/`unwrap` would have no strict invariant
 * anywhere.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

type QueryOneMock = Mock<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>;

let mockQueryOne: QueryOneMock;

function resetMocks(): void {
  mockQueryOne = vi
    .fn<(sql: string, params?: unknown[]) => Promise<Record<string, unknown> | null>>()
    .mockResolvedValue(null);
}
resetMocks();

vi.mock("@vex-agent/db/client.js", () => ({
  query: vi.fn(),
  queryOne: (sql: string, params?: unknown[]) => mockQueryOne(sql, params),
  execute: vi.fn(),
  queryWith: vi.fn(),
  queryOneWith: (_c: unknown, sql: string, params?: unknown[]) => mockQueryOne(sql, params as never),
  executeWith: vi.fn(),
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

vi.mock("@vex-agent/engine/runtime/lease-and-status/session-control-lock.js", () => ({
  acquireSessionControlLock: vi.fn(async () => undefined),
}));

const repo = await import("@vex-agent/db/repos/agent-activity.js");

const SESSION_ID = "00000000-0000-4000-8000-000000000001";

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 42,
    protocol_execution_id: 7,
    event_index: 0,
    event_role: "swap",
    record_version: 1,
    kind: "swap",
    protocol: "kyberswap",
    chain_id: 4663,
    chain_family: "eip155",
    status: "pending",
    wallet_address: "0xWALLET",
    session_id: SESSION_ID,
    tx_hash: "0xHASH",
    created_at: new Date("2026-07-30T09:00:00.000Z"),
    updated_at: new Date("2026-07-30T09:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  resetMocks();
});

describe("confirmActivityEventStatusOnly", () => {
  it("is exported from the agent-activity facade, not only swap-lifecycle", () => {
    expect(typeof repo.confirmActivityEventStatusOnly).toBe("function");
  });

  it("CAS-confirms a pending row without writing any executed amount column", async () => {
    // 1st queryOne: the pre-read (session id). 2nd: the CAS UPDATE.
    mockQueryOne.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "confirmed" }));

    const result = await repo.confirmActivityEventStatusOnly(42, "receipt_status_only_evm");

    expect(result.applied).toBe(true);
    expect(result.row.status).toBe("confirmed");

    const update = mockQueryOne.mock.calls[1]?.[0] ?? "";
    expect(update).toContain("status = 'confirmed'");
    expect(update).toContain("confirmed_at = NOW()");
    expect(update).toContain("WHERE id = $1 AND status = 'pending'");
    expect(update).not.toContain("executed_amount");
    // The caller-supplied provenance rides along; it says HOW the status was
    // established and nothing about the amounts (migration 067).
    expect(mockQueryOne.mock.calls[1]?.[1]).toEqual([42, "receipt_status_only_evm"]);
    expect(update).toContain("confirmation_source = $2");
    // `settlement_source` is deliberately untouched: this sweep learned nothing
    // whatsoever about the money, so it has no business stating how it is known.
    expect(update).not.toContain("settlement_source");
  });

  it("leaves any PRE-EXISTING executed_* values untouched — it writes no amount column at all", async () => {
    // A row can already carry executed legs (a handler decoded its receipt but
    // crashed before finalizing) and still be picked up by the sweep. The
    // status-only finalizer must never clear them: it writes status and
    // timestamps, so whatever the handler proved survives verbatim.
    const decoded = {
      executed_amount_in_raw: "1400000",
      executed_amount_in_human: "1.4",
      executed_amount_out_raw: "400000000000000",
      executed_amount_out_human: "0.0004",
    };
    mockQueryOne
      .mockResolvedValueOnce(row(decoded))
      .mockResolvedValueOnce(row({ ...decoded, status: "confirmed" }));

    const result = await repo.confirmActivityEventStatusOnly(42, "receipt_status_only_evm");

    const update = mockQueryOne.mock.calls[1]?.[0] ?? "";
    // No amount column is named, so none can be nulled by omission.
    expect(update).not.toMatch(/executed_amount_(in|out)2?_(raw|human)/);
    // The CAS carries the row id and its provenance — no amount parameter exists.
    expect(mockQueryOne.mock.calls[1]?.[1]).toEqual([42, "receipt_status_only_evm"]);
    expect(result.row.executedAmountInRaw).toBe("1400000");
    expect(result.row.executedAmountOutRaw).toBe("400000000000000");
  });

  it("reports a CAS miss with the current row instead of throwing", async () => {
    mockQueryOne
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(row({ status: "confirmed" }));

    const result = await repo.confirmActivityEventStatusOnly(42, "receipt_status_only_evm");

    expect(result.applied).toBe(false);
    expect(result.row.status).toBe("confirmed");
  });

  it("throws when the row does not exist", async () => {
    mockQueryOne.mockResolvedValue(null);
    await expect(repo.confirmActivityEventStatusOnly(42, "receipt_status_only_evm")).rejects.toThrow(/does not exist/);
  });
});

describe("confirmActivityEvent — wrap/unwrap strict guard (replaces the dropped 051 CHECK)", () => {
  it.each(["wrap", "unwrap"])("refuses to confirm a %s row without both executed raws", async (role) => {
    mockQueryOne.mockResolvedValue(row({ event_role: role, kind: "wrap" }));

    await expect(
      repo.confirmActivityEvent(42, { executedAmountInRaw: "1", executedAmountInHuman: "1" }),
    ).rejects.toThrow(/executedAmountInRaw \+ executedAmountOutRaw/);

    await expect(repo.confirmActivityEvent(42, {})).rejects.toThrow(
      /executedAmountInRaw \+ executedAmountOutRaw/,
    );
  });

  it("still confirms a wrap row that carries both executed raws", async () => {
    mockQueryOne
      .mockResolvedValueOnce(row({ event_role: "wrap", kind: "wrap" }))
      .mockResolvedValueOnce(row({ event_role: "wrap", kind: "wrap", status: "confirmed" }));

    const result = await repo.confirmActivityEvent(42, {
      executedAmountInRaw: "1",
      executedAmountOutRaw: "1",
    });

    expect(result.applied).toBe(true);
  });
});
