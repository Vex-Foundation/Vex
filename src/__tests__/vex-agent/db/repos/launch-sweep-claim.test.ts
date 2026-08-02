/**
 * The identity sweep's candidate CLAIM — the anti-starvation contract, pinned
 * as SQL shape (this suite has no real Postgres) plus the launch-specific
 * `agent_activity` finalizers that go with it.
 *
 * The starvation is silent, which is why it needs a pin: with
 * `ORDER BY created_at ASC LIMIT 25` over rows the sweep may leave UNCHANGED,
 * 25 permanently-ambiguous launches occupy the window forever and row 26 is
 * never inspected — while the sweep reports `checked: 25` every tick and looks
 * perfectly healthy.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

let mockQuery: Mock;
let mockQueryOne: Mock;

function reset(): void {
  mockQuery = vi.fn().mockResolvedValue([]);
  mockQueryOne = vi.fn().mockResolvedValue(null);
}
reset();

vi.mock("@vex-agent/db/client.js", () => ({
  query: (...a: unknown[]) => mockQuery(...a),
  queryOne: (...a: unknown[]) => mockQueryOne(...a),
  queryOneWith: vi.fn(),
  queryWith: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
  getPool: vi.fn(),
}));

const { claimBroadcastPendingForSweep } = await import(
  "@vex-agent/db/repos/token-launch-intents/sweep-claim.js"
);
const { stampLaunchOutputIdentityByTxHash, fillLaunchOutputIdentityOnConfirmed } = await import(
  "@vex-agent/db/repos/agent-activity/launch-lifecycle.js"
);

beforeEach(() => { reset(); });

describe("claimBroadcastPendingForSweep", () => {
  async function claimSql(): Promise<string> {
    await claimBroadcastPendingForSweep(25);
    return (mockQuery.mock.calls[0]![0] as string).replace(/\s+/g, " ");
  }

  it("orders by LAST CHECKED, not by creation — so an inspected row goes to the back", async () => {
    const sql = await claimSql();
    expect(sql).toContain("ORDER BY COALESCE(last_checked_at, created_at) ASC, intent_id ASC");
    expect(sql).not.toContain("ORDER BY created_at ASC LIMIT");
  });

  it("STAMPS last_checked_at in the same statement that serves the row", async () => {
    const sql = await claimSql();
    // One statement: a crash between "served" and "stamped" is unrepresentable,
    // and an ambiguous answer still advances the window.
    expect(sql).toContain("SET last_checked_at = NOW()");
    expect(sql).toContain("WITH candidates AS");
  });

  it("takes disjoint batches under concurrency (FOR UPDATE SKIP LOCKED)", async () => {
    expect(await claimSql()).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("keeps the candidate predicate and the bound", async () => {
    const sql = await claimSql();
    expect(sql).toContain("WHERE status = 'broadcast_pending' AND tx_hash IS NOT NULL");
    expect(sql).toContain("LIMIT $1");
    // Global by design; its writes are still session-scoped CAS.
    expect(sql).not.toContain("session_id = $");
    expect(mockQuery.mock.calls[0]![1]).toEqual([25]);
  });

  it("stamps NOTHING but scheduling — no status, hash, identity or money column", async () => {
    const sql = await claimSql();
    const setClause = sql.slice(sql.indexOf("SET last_checked_at"), sql.indexOf("FROM candidates"));
    for (const column of ["status", "tx_hash", "token_address", "prebuy_raw", "failure_reason"]) {
      expect(setClause).not.toContain(column);
    }
  });
});

describe("stampLaunchOutputIdentityByTxHash", () => {
  it("fills in the created token only where it is still blank, and only for launches", async () => {
    mockQueryOne.mockResolvedValue({ id: 5 });
    const stamped = await stampLaunchOutputIdentityByTxHash("0xhash", "0xTOKEN");
    expect(stamped).toBe(true);
    const [sql, params] = mockQueryOne.mock.calls[0]!;
    const flat = (sql as string).replace(/\s+/g, " ");
    // Never an overwrite: the handler's own atomic confirm always wins.
    expect(flat).toContain("token_out_address IS NULL");
    expect(flat).toContain("event_role = 'token_launch'");
    // Identity ONLY — the sweep proves no amount and must not pretend to.
    expect(flat).not.toContain("status =");
    expect(flat).not.toContain("executed_amount");
    expect(params).toEqual(["0xhash", "0xTOKEN"]);
  });

  it("reports false when no row was blank — a real repair is never assumed", async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await stampLaunchOutputIdentityByTxHash("0xhash", "0xTOKEN")).toBe(false);
  });
});

describe("fillLaunchOutputIdentityOnConfirmed", () => {
  const identity = {
    executedAmountInRaw: "1300000000000000",
    executedAmountOutRaw: "197913781308210736292461",
    tokenOutAddress: "0xTOKEN",
    tokenOutSymbol: "VEX",
    tokenOutDecimals: 18,
  };

  it("repairs the row the status-only sweep confirmed WITHOUT amounts", async () => {
    mockQueryOne.mockResolvedValue({ id: 5 });
    expect(await fillLaunchOutputIdentityOnConfirmed(5, identity)).toBe(true);
    const flat = (mockQueryOne.mock.calls[0]![0] as string).replace(/\s+/g, " ");
    // Exactly the row the sweep leaves behind: already confirmed, token blank.
    expect(flat).toContain("status = 'confirmed'");
    expect(flat).toContain("event_role = 'token_launch'");
    expect(flat).toContain("token_out_address IS NULL");
  });

  it("never re-confirms and never overwrites an amount someone already proved", async () => {
    mockQueryOne.mockResolvedValue({ id: 5 });
    await fillLaunchOutputIdentityOnConfirmed(5, identity);
    const flat = (mockQueryOne.mock.calls[0]![0] as string).replace(/\s+/g, " ");
    // Status is untouched — the row is already confirmed; this is not a second
    // confirmation.
    expect(flat).not.toContain("SET status");
    expect(flat).not.toContain("confirmed_at = NOW()");
    // COALESCE, so a real amount already present wins over this fill-in.
    expect(flat).toContain("COALESCE(executed_amount_out_raw, $5)");
  });

  it("reports false when there was nothing to repair", async () => {
    mockQueryOne.mockResolvedValue(null);
    expect(await fillLaunchOutputIdentityOnConfirmed(5, identity)).toBe(false);
  });
});
