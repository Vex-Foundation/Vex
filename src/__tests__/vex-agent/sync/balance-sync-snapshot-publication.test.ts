/**
 * WP8 - SERIALIZED SNAPSHOT PUBLICATION.
 *
 * The defect: the pending-activity guard was evaluated ONCE, before a wallet
 * sweep that runs for minutes, and each wallet was then inserted on its own
 * arbitrary pool client. A transaction starting mid-sweep was invisible to a
 * predicate read minutes earlier, and the snapshot it produced became the
 * baseline every later P&L figure is measured against.
 *
 * What is pinned here:
 *
 *  1. the gate is evaluated UNDER the activity-table lock, in the same
 *     transaction as the insert, in that exact order;
 *  2. a writer that would commit immediately after the predicate cannot slip
 *     in, because the lock is already held (driven by a controlled gate - never
 *     a wall-clock sleep);
 *  3. a transaction that BEGINS and SETTLES inside the scan is caught by the
 *     generation fence even though nothing is pending by the time we look;
 *  4. a lock timeout SKIPS the snapshot and reports it - it never fails the
 *     balance refresh;
 *  5. whole group or none;
 *  6. an unresolved intent past the threshold still BLOCKS and is reported as
 *     unreconciled. Age escalates the report; it never releases publication.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── The scripted Postgres ────────────────────────────────────────────────

interface Statement { sql: string; params?: unknown[] }

/** Rows the gate query should return. Empty = nothing in flight. */
let blockerRows: Record<string, unknown>[] = [];
/** The fence the gate reads INSIDE the transaction. */
let fenceInTx = { max_id: "0", max_updated_at: "epoch", row_count: "0" };
/** Set to make `LOCK TABLE` reject, as Postgres does on `lock_timeout`. */
let lockError: (Error & { code?: string }) | null = null;

const statements: Statement[] = [];

/** True while our publisher holds `agent_activity` - the fake's whole point. */
let activityTableLocked = false;

async function fakeQuery(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number }> {
  statements.push({ sql, params });
  if (sql.includes("LOCK TABLE agent_activity")) {
    if (lockError) throw lockError;
    activityTableLocked = true;
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("COMMIT") || sql.includes("ROLLBACK")) {
    activityTableLocked = false;
    return { rows: [], rowCount: 0 };
  }
  if (sql.includes("MAX(id)")) return { rows: [fenceInTx], rowCount: 1 };
  if (sql.includes("agent_activity_pending")) return { rows: blockerRows, rowCount: blockerRows.length };
  return { rows: [], rowCount: 0 };
}

const fakeClient = { query: (sql: string, params?: unknown[]) => fakeQuery(sql, params) };

vi.mock("@vex-agent/db/client.js", () => ({
  getPool: () => fakeClient,
  // A faithful stand-in for the real helper: BEGIN, run, COMMIT, ROLLBACK on
  // throw - so "whole group or none" is a property of the code under test and
  // not of the fake.
  withTransaction: async (fn: (c: unknown) => Promise<unknown>) => {
    await fakeClient.query("BEGIN");
    try {
      const result = await fn(fakeClient);
      await fakeClient.query("COMMIT");
      return result;
    } catch (err) {
      await fakeClient.query("ROLLBACK");
      throw err;
    }
  },
  queryOneWith: async (_e: unknown, sql: string, params?: unknown[]) => {
    const res = await fakeQuery(sql, params);
    return res.rows[0] ?? null;
  },
  queryWith: async (_e: unknown, sql: string, params?: unknown[]) => (await fakeQuery(sql, params)).rows,
  executeWith: async (_e: unknown, sql: string, params?: unknown[]) => (await fakeQuery(sql, params)).rowCount,
}));

const mockInsertSnapshot = vi.fn();
vi.mock("@vex-agent/db/repos/balances.js", () => ({
  insertSnapshot: (...a: unknown[]) => mockInsertSnapshot(...a),
}));

const mockWarn = vi.fn();
const mockInfo = vi.fn();
const mockError = vi.fn();
vi.mock("@utils/logger.js", () => ({
  default: {
    info: (...a: unknown[]) => mockInfo(...a),
    warn: (...a: unknown[]) => mockWarn(...a),
    error: (...a: unknown[]) => mockError(...a),
    debug: vi.fn(),
  },
}));

const { publishSnapshotGroup, logPublicationOutcome, PUBLICATION_LOCK_TIMEOUT_MS } = await import(
  "../../../vex-agent/sync/balance-sync/snapshot-publication.js"
);
const { UNRECONCILED_AFTER_MS } = await import(
  "../../../vex-agent/sync/balance-sync/publication-gate.js"
);

const WALLETS = ["0xAAA", "0xBBB"];
const FENCE_AT_START = { maxId: "7", maxUpdatedAt: "2026-08-31 10:00:00+00", rowCount: "3" };

function draft(address: string) {
  return {
    walletFamily: "eip155",
    walletAddress: address,
    totalUsd: 100,
    positions: { chains: [] },
    activeChains: ["8453"],
  };
}

function publish(overrides: Partial<Parameters<typeof publishSnapshotGroup>[0]> = {}) {
  return publishSnapshotGroup({
    snapshotGroupId: "group-1",
    walletAddresses: WALLETS,
    fenceAtCycleStart: FENCE_AT_START,
    drafts: WALLETS.map(draft),
    ...overrides,
  });
}

/** The index of the first statement containing `needle`, or -1. */
const indexOf = (needle: string) => statements.findIndex((s) => s.sql.includes(needle));

beforeEach(() => {
  vi.clearAllMocks();
  statements.length = 0;
  blockerRows = [];
  fenceInTx = { max_id: "7", max_updated_at: "2026-08-31 10:00:00+00", row_count: "3" };
  lockError = null;
  activityTableLocked = false;
  let n = 0;
  mockInsertSnapshot.mockImplementation(async () => {
    // The repo is mocked, so its INSERT never reaches the scripted client. This
    // marker keeps the statement ORDER assertions honest about where in the
    // transaction the group is written.
    statements.push({ sql: "INSERT INTO proj_portfolio_snapshots" });
    return { snapshotId: ++n, pnlVsPrev: null };
  });
});

// ── 1. Pending activity at publication time ──────────────────────────────

describe("pending activity at PUBLICATION time", () => {
  it("blocks the group and writes nothing, so the prior committed snapshot survives", async () => {
    blockerRows = [
      { kind: "agent_activity_pending", ref: "901", detail: "swap", since: new Date() },
    ];

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("in_flight_money_state");
    expect(outcome.blockers[0]?.kind).toBe("agent_activity_pending");
    // Not a partial group - ZERO rows. Nothing overwrites the previous baseline.
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    expect(indexOf("INSERT INTO proj_portfolio_snapshots")).toBe(-1);
  });
});

// ── 2. The writer that commits right after the check ─────────────────────

describe("a writer committing immediately after the predicate", () => {
  it("cannot slip in, because the lock is taken BEFORE the predicate is read", async () => {
    await publish();

    const lockAt = indexOf("LOCK TABLE agent_activity IN SHARE MODE");
    const timeoutAt = indexOf("SET LOCAL lock_timeout");
    const gateAt = indexOf("agent_activity_pending");
    const fenceAt = indexOf("MAX(id)");
    const insertAt = indexOf("INSERT INTO proj_portfolio_snapshots");

    // The whole point: a re-read of the predicate inside the transaction would
    // still race a writer committing an instant later. Only a lock that
    // CONFLICTS with that writer turns the predicate into a boundary - so it
    // must come first, and the insert must happen while it is still held.
    expect(timeoutAt).toBeGreaterThanOrEqual(0);
    expect(timeoutAt).toBeLessThan(lockAt);
    expect(lockAt).toBeLessThan(gateAt);
    expect(gateAt).toBeLessThan(fenceAt);
    expect(fenceAt).toBeLessThan(insertAt);
    expect(indexOf("COMMIT")).toBeGreaterThan(insertAt);
  });

  it("is parked by the lock for the whole publication, and lands strictly after COMMIT", async () => {
    // The controlled gate: the "writer" is released the instant the gate query
    // has been issued - the exact moment a naive re-read would be beaten - and
    // then has to wait for the lock like any real ROW EXCLUSIVE writer. No
    // wall-clock sleep is involved anywhere.
    const writerOrder: string[] = [];
    let releaseWriter: (() => void) | null = null;
    const writerReleased = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });

    const writer = (async () => {
      await writerReleased;
      // A ROW EXCLUSIVE writer blocks while SHARE is held.
      while (activityTableLocked) await Promise.resolve();
      writerOrder.push("writer_committed");
    })();

    const originalQuery = fakeClient.query;
    fakeClient.query = async (sql: string, params?: unknown[]) => {
      // Recorded BEFORE the statement runs: releasing the table lock is what
      // COMMIT does, so anything observed after it has already been let go.
      if (sql.includes("COMMIT")) writerOrder.push("publisher_committed");
      const res = await originalQuery(sql, params);
      if (sql.includes("agent_activity_pending")) releaseWriter?.();
      return res;
    };
    try {
      const outcome = await publish();
      await writer;
      expect(outcome.published).toBe(true);
    } finally {
      fakeClient.query = originalQuery;
    }

    expect(writerOrder).toEqual(["publisher_committed", "writer_committed"]);
  });
});

// ── 3. Begins AND settles during the scan ────────────────────────────────

describe("a transaction that begins and settles during the scan", () => {
  it("is caught by the generation fence even though nothing is pending", async () => {
    blockerRows = []; // it already terminalized - the pending predicate is clean
    fenceInTx = { max_id: "9", max_updated_at: "2026-08-31 10:04:00+00", row_count: "4" };

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    // Wallets scanned before it and after it were read on opposite sides of a
    // money movement; the group would look perfectly settled and be wrong.
    expect(outcome.reason).toBe("activity_transition");
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it("also catches a pure status transition on a pre-existing row (no new id)", async () => {
    fenceInTx = { max_id: "7", max_updated_at: "2026-08-31 10:04:00+00", row_count: "3" };

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("activity_transition");
  });

  it("publishes when the generation is byte-identical to the cycle-start stamp", async () => {
    const outcome = await publish();

    expect(outcome.published).toBe(true);
    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.rows).toHaveLength(2);
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(2);
    // Every row goes in on the TRANSACTION's client, not an arbitrary pool one.
    for (const call of mockInsertSnapshot.mock.calls) expect(call[1]).toBe(fakeClient);
  });
});

// ── 4. Lock timeout ──────────────────────────────────────────────────────

describe("lock timeout", () => {
  it("skips publication and reports it - it never fails the refresh", async () => {
    lockError = Object.assign(new Error("canceling statement due to lock timeout"), {
      code: "55P03",
    });

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("lock_unavailable");
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    // Reported, not silent.
    expect(mockInfo).toHaveBeenCalledWith(
      "sync.balance.snapshot_lock_unavailable",
      expect.objectContaining({ code: "55P03" }),
    );
  });

  it("treats a deadlock the same way", async () => {
    lockError = Object.assign(new Error("deadlock detected"), { code: "40P01" });

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("lock_unavailable");
  });

  it("bounds the wait it asks Postgres for", async () => {
    await publish();
    const stmt = statements.find((s) => s.sql.includes("SET LOCAL lock_timeout"));
    expect(stmt?.sql).toBe(`SET LOCAL lock_timeout = ${PUBLICATION_LOCK_TIMEOUT_MS}`);
  });

  it("clamps a caller-supplied timeout instead of interpolating it raw", async () => {
    await publish({ lockTimeoutMs: 10 ** 9 });
    expect(statements.find((s) => s.sql.includes("SET LOCAL lock_timeout"))?.sql)
      .toBe("SET LOCAL lock_timeout = 30000");
  });
});

// ── 5. Whole group or none ───────────────────────────────────────────────

describe("whole group or none", () => {
  it("leaves ZERO rows from the group when one wallet's insert fails", async () => {
    mockInsertSnapshot.mockReset();
    mockInsertSnapshot
      .mockResolvedValueOnce({ snapshotId: 1, pnlVsPrev: null })
      .mockRejectedValueOnce(new Error("constraint violation"));

    const outcome = await publish({ drafts: ["0xAAA", "0xBBB", "0xCCC"].map(draft) });

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    // A half-populated snapshotGroupId breaks BOTH the aggregate stitch and the
    // per-wallet pnl_vs_prev chain, which would then span a gap on some wallets
    // and not others.
    expect(outcome.reason).toBe("publish_failed");
    expect(indexOf("ROLLBACK")).toBeGreaterThan(-1);
    expect(indexOf("COMMIT")).toBe(-1);
    // The third wallet is never even attempted.
    expect(mockInsertSnapshot).toHaveBeenCalledTimes(2);
  });

  it("logs an insert failure at ERROR - it is a defect, not a busy money path", async () => {
    mockInsertSnapshot.mockReset();
    mockInsertSnapshot.mockRejectedValue(new Error("boom"));
    const outcome = await publish();
    logPublicationOutcome(outcome, "group-1");
    expect(mockError).toHaveBeenCalledWith(
      "sync.balance.snapshot_publish_failed",
      expect.objectContaining({ reason: "publish_failed" }),
    );
  });
});

// ── 6. An unresolved intent never time-releases ──────────────────────────

describe("an unresolved intent older than the threshold", () => {
  const ancient = new Date(Date.now() - UNRECONCILED_AFTER_MS - 60_000);

  it("STILL blocks publication - age escalates the report, never releases it", async () => {
    blockerRows = [{
      kind: "wallet_transaction_confirmation_unknown",
      ref: "wti_9",
      detail: "broadcast_unconfirmed",
      since: ancient,
    }];

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("in_flight_money_state");
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    // A snapshot written across an UNKNOWN transaction outcome corrupts every
    // later P&L figure; a missing snapshot is recoverable next cycle.
    expect(outcome.blockers[0]?.unreconciled).toBe(true);
    expect(outcome.blockers[0]?.ageSeconds).toBeGreaterThanOrEqual(UNRECONCILED_AFTER_MS / 1000);
  });

  it("is reported as UNRECONCILED, distinctly from an ordinary deferral", async () => {
    blockerRows = [{
      kind: "wallet_wrap_confirmation_unknown",
      ref: "wwi_3",
      detail: "review_required",
      since: ancient,
    }];

    logPublicationOutcome(await publish(), "group-1");

    expect(mockWarn).toHaveBeenCalledWith(
      "sync.balance.snapshot_blocked_unreconciled",
      expect.objectContaining({
        unreconciledCount: 1,
        blockers: [expect.objectContaining({ kind: "wallet_wrap_confirmation_unknown", ref: "wwi_3" })],
      }),
    );
  });

  it("a fresh blocker is an ordinary deferral, not an escalation", async () => {
    blockerRows = [
      { kind: "agent_activity_pending", ref: "12", detail: "swap", since: new Date() },
    ];

    logPublicationOutcome(await publish(), "group-1");

    expect(mockWarn).not.toHaveBeenCalledWith(
      "sync.balance.snapshot_blocked_unreconciled",
      expect.anything(),
    );
    expect(mockInfo).toHaveBeenCalledWith(
      "sync.balance.snapshot_deferred",
      expect.objectContaining({ reason: "in_flight_money_state", unreconciledCount: 0 }),
    );
  });
});
