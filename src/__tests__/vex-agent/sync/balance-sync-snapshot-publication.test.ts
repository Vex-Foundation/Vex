/**
 * SERIALIZED SNAPSHOT PUBLICATION, and the IN-FLIGHT LEDGER it records.
 *
 * The original defect: the pending-activity guard was evaluated ONCE, before a
 * wallet sweep that runs for minutes, and each wallet was then inserted on its
 * own arbitrary pool client. A transaction starting mid-sweep was invisible to
 * a predicate read minutes earlier.
 *
 * The reversed decision (owner, 2026-09-04): in-flight money no longer WITHHOLDS
 * a group, because withholding it is how one unreported bridge row froze every
 * snapshot for 31 days. It is ACCOUNTED FOR instead.
 *
 * What is pinned here:
 *
 *  1. a pending bridge row publishes, and the group carries it as `in_transit`
 *     with its expected output amount, symbol and USD estimate;
 *  2. the same row past its bound is `unresolved`: listed, counted, and in NO
 *     total;
 *  3. the bound table is exhaustive over the seven kinds;
 *  4. the ledger is read UNDER the activity-table lock, in the same transaction
 *     as the insert, in that exact order, and a writer that would commit
 *     immediately after cannot slip in (driven by a controlled gate - never a
 *     wall-clock sleep);
 *  5. a bookkeeping touch does NOT trip the fence; a settlement during the scan
 *     does;
 *  6. a lock timeout SKIPS the snapshot and reports it - it never fails the
 *     balance refresh;
 *  7. whole group or none, the group record included.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── The scripted Postgres ────────────────────────────────────────────────

interface Statement { sql: string; params?: unknown[] }

/** Rows the ledger query should return. Empty = nothing in flight. */
let ledgerRows: Record<string, unknown>[] = [];
/** The fence the gate reads INSIDE the transaction. */
let fenceInTx = { max_id: "0", row_count: "0", pending_count: "0", confirmed_count: "0" };
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
  if (sql.includes("agent_activity_pending")) return { rows: ledgerRows, rowCount: ledgerRows.length };
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
const { boundFor } = await import("../../../vex-agent/sync/balance-sync/publication-gate.js");
type InFlightKind = Parameters<typeof boundFor>[0];

const WALLETS = ["0xAAA", "0xBBB"];
const FENCE_AT_START = {
  maxId: "7",
  rowCount: "3",
  pendingCount: "1",
  confirmedCount: "2",
};

const HOUR_SECONDS = 3600;
/** A row created `seconds` ago, as the driver hands it back. */
const agedBy = (seconds: number) => new Date(Date.now() - seconds * 1000);

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
  ledgerRows = [];
  fenceInTx = { max_id: "7", row_count: "3", pending_count: "1", confirmed_count: "2" };
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

// ── 1. In-flight money is ACCOUNTED FOR, never a veto ────────────────────

/** The owner's row: a bridge fill the provider has not conclusively reported. */
function bridgeFill(ageSeconds: number) {
  return {
    kind: "agent_activity_pending",
    ref: "132",
    detail: "bridge_fill_expected",
    since: agedBy(ageSeconds),
    expires_at: null,
    amount_text: "150.5",
    amount_decimals: null,
    symbol: "USDC",
    usd_est: "150.25",
  };
}

describe("a pending bridge fill at PUBLICATION time", () => {
  it("no longer withholds the group - the snapshot is published with it named", async () => {
    ledgerRows = [bridgeFill(10 * 60)];

    const outcome = await publish();

    expect(outcome.published).toBe(true);
    if (!outcome.published) throw new Error("unreachable");
    // The regression this whole change exists for: ONE unreported bridge row
    // used to withhold every snapshot, forever.
    expect(outcome.rows).toHaveLength(2);
    expect(indexOf("INSERT INTO proj_portfolio_snapshots")).toBeGreaterThan(-1);
  });

  it("carries it in the ledger as in_transit, with its expected OUTPUT leg", async () => {
    ledgerRows = [bridgeFill(10 * 60)];

    const outcome = await publish();

    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.ledger.entries).toEqual([
      {
        kind: "agent_activity_pending",
        ref: "132",
        detail: "bridge_fill_expected",
        standing: "in_transit",
        ageSeconds: 600,
        // The INPUT has already left the wallet, so what is in transit is what
        // is expected to arrive.
        amountHuman: "150.5",
        symbol: "USDC",
        usdEstimate: 150.25,
      },
    ]);
    expect(outcome.ledger.inTransitUsd).toBeCloseTo(150.25, 6);
    expect(outcome.ledger.unresolvedCount).toBe(0);
    // settled is what was actually inserted, not what was offered.
    expect(outcome.ledger.settledUsd).toBeCloseTo(200, 6);
  });

  it("writes the group record in the SAME transaction, after the per-wallet rows", async () => {
    ledgerRows = [bridgeFill(10 * 60)];

    await publish();

    const groupAt = indexOf("INSERT INTO proj_portfolio_snapshot_groups");
    expect(groupAt).toBeGreaterThan(indexOf("INSERT INTO proj_portfolio_snapshots"));
    expect(indexOf("COMMIT")).toBeGreaterThan(groupAt);

    const stmt = statements[groupAt];
    expect(stmt?.params?.[0]).toBe("group-1");
    expect(stmt?.params?.[2]).toBeCloseTo(150.25, 6);
    expect(stmt?.params?.[3]).toBe(0);
    expect(JSON.parse(String(stmt?.params?.[4]))).toHaveLength(1);
  });

  it("at three hours the SAME row is unresolved: listed, counted, in NO total", async () => {
    ledgerRows = [bridgeFill(3 * HOUR_SECONDS)];

    const outcome = await publish();

    expect(outcome.published).toBe(true);
    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.ledger.entries[0]?.standing).toBe("unresolved");
    expect(outcome.ledger.unresolvedCount).toBe(1);
    // Money whose outcome nobody can prove is asserted neither present nor
    // lost: its estimate is excluded from the in-transit total even though the
    // entry still carries it for the operator to read.
    expect(outcome.ledger.inTransitUsd).toBe(0);
    expect(outcome.ledger.entries[0]?.usdEstimate).toBeCloseTo(150.25, 6);
  });

  it("reports an unresolved entry by ref and kind, and never its amount", async () => {
    ledgerRows = [bridgeFill(3 * HOUR_SECONDS)];

    logPublicationOutcome(await publish(), "group-1");

    expect(mockWarn).toHaveBeenCalledWith(
      "sync.balance.snapshot_unresolved_money",
      expect.objectContaining({
        unresolvedCount: 1,
        unresolved: [{ kind: "agent_activity_pending", ref: "132", ageSeconds: 3 * HOUR_SECONDS }],
      }),
    );
    const warned = JSON.stringify(mockWarn.mock.calls);
    expect(warned).not.toContain("150.5");
    expect(warned).not.toContain("USDC");
  });

  it("a non-bridge pending leg reports its INPUT leg instead", async () => {
    ledgerRows = [{
      kind: "agent_activity_pending",
      ref: "901",
      detail: "swap",
      since: agedBy(60),
      expires_at: null,
      amount_text: "1.25",
      amount_decimals: null,
      symbol: "WETH",
      usd_est: "4200",
    }];

    const outcome = await publish();

    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.ledger.entries[0]).toMatchObject({
      standing: "in_transit",
      amountHuman: "1.25",
      symbol: "WETH",
      usdEstimate: 4200,
    });
  });

  it("converts a base-unit amount through its decimals, never through a float", async () => {
    ledgerRows = [{
      kind: "wallet_wrap_intent_live",
      ref: "wwi_1",
      detail: "consuming",
      since: agedBy(30),
      expires_at: new Date(Date.now() + 600_000),
      // 1 wei short of 1 ETH: a float64 cannot represent this, a string can.
      amount_text: "999999999999999999",
      amount_decimals: 18,
      symbol: "WETH",
      usd_est: null,
    }];

    const outcome = await publish();

    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.ledger.entries[0]?.amountHuman).toBe("0.999999999999999999");
    // No price for a wrap: "not priced" is not "worth zero".
    expect(outcome.ledger.entries[0]?.usdEstimate).toBeNull();
    expect(outcome.ledger.inTransitUsd).toBe(0);
  });

  it("an intent past its OWN expiry is unresolved even though it is young", async () => {
    ledgerRows = [{
      kind: "wallet_intent_live",
      ref: "wi_1",
      detail: "consuming",
      since: agedBy(120),
      expires_at: new Date(Date.now() - 1_000),
      amount_text: "12.5",
      amount_decimals: null,
      symbol: "USDC",
      usd_est: null,
    }];

    const outcome = await publish();

    if (!outcome.published) throw new Error("unreachable");
    // The CAS filters on `expires_at > NOW()`, so this can never be claimed:
    // it is dead, not slow, and age would have called it in transit.
    expect(outcome.ledger.entries[0]?.standing).toBe("unresolved");
    expect(outcome.ledger.unresolvedCount).toBe(1);
  });

  it("publishes an EMPTY ledger when nothing is in flight", async () => {
    const outcome = await publish();

    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.ledger.entries).toEqual([]);
    expect(outcome.ledger.inTransitUsd).toBe(0);
    expect(outcome.ledger.unresolvedCount).toBe(0);
    expect(outcome.ledger.truncated).toBe(false);
  });
});

// ── 1b. The bound table, exhaustively ────────────────────────────────────

describe("the standing bound table", () => {
  const KINDS: readonly InFlightKind[] = [
    "agent_activity_pending",
    "wallet_intent_live",
    "wallet_confirmation_unknown",
    "wallet_transaction_intent_live",
    "wallet_transaction_confirmation_unknown",
    "wallet_wrap_intent_live",
    "wallet_wrap_confirmation_unknown",
  ];

  const EXPECTED: ReadonlyArray<readonly [InFlightKind, string | null, string, number]> = [
    ["agent_activity_pending", "bridge_fill_expected", "max-age", 2 * HOUR_SECONDS],
    ["agent_activity_pending", "swap", "max-age", HOUR_SECONDS],
    ["agent_activity_pending", "predict_buy", "max-age", HOUR_SECONDS],
    ["agent_activity_pending", null, "max-age", HOUR_SECONDS],
    ["wallet_intent_live", "consuming", "own-expiry", HOUR_SECONDS],
    // A row that has ALREADY broadcast is reported under a `*_intent_live`
    // kind, and its `expires_at` bounds the APPROVAL, which stopped being the
    // relevant clock the moment the transaction left.
    ["wallet_intent_live", "broadcast_unconfirmed", "max-age", 2 * HOUR_SECONDS],
    ["wallet_transaction_intent_live", "broadcast_unconfirmed", "max-age", 2 * HOUR_SECONDS],
    ["wallet_wrap_intent_live", "broadcast_unconfirmed", "max-age", 2 * HOUR_SECONDS],
    ["wallet_confirmation_unknown", "broadcast_unconfirmed", "max-age", 2 * HOUR_SECONDS],
    ["wallet_transaction_intent_live", "consuming", "own-expiry", HOUR_SECONDS],
    ["wallet_transaction_confirmation_unknown", "review_required", "max-age", 2 * HOUR_SECONDS],
    ["wallet_wrap_intent_live", "review_required", "own-expiry", HOUR_SECONDS],
    ["wallet_wrap_confirmation_unknown", "audit_failed", "max-age", 2 * HOUR_SECONDS],
  ];

  it.each(EXPECTED)("%s / %s is bounded by %s at %i s", (kind, detail, rule, seconds) => {
    const bound = boundFor(kind, detail);
    expect(bound.rule).toBe(rule);
    expect(
      bound.rule === "max-age" ? bound.maxAgeSeconds : bound.fallbackMaxAgeSeconds,
    ).toBe(seconds);
  });

  it("covers EVERY kind - a new kind cannot reach production unbounded", () => {
    for (const kind of KINDS) {
      const bound = boundFor(kind, null);
      expect(["max-age", "own-expiry"]).toContain(bound.rule);
      expect(bound.why.length).toBeGreaterThan(0);
    }
    // The table is exhaustive by TYPE (Record<InFlightKind, ...>); this asserts
    // the LIST above is exhaustive too, so a kind added to the union without a
    // row here fails loudly rather than silently skipping its case.
    expect(KINDS).toHaveLength(7);
    expect(new Set(EXPECTED.map(([kind]) => kind))).toEqual(new Set(KINDS));
  });
});

// ── 2. The writer that commits right after the check ─────────────────────

describe("a writer committing immediately after the predicate", () => {
  it("cannot slip in, because the lock is taken BEFORE the predicate is read", async () => {
    await publish();

    const lockAt = indexOf("LOCK TABLE agent_activity IN SHARE MODE");
    const timeoutAt = indexOf("SET LOCAL lock_timeout");
    const gateAt = indexOf("agent_activity_pending");
    const groupAt = indexOf("INSERT INTO proj_portfolio_snapshot_groups");
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
    expect(insertAt).toBeLessThan(groupAt);
    expect(indexOf("COMMIT")).toBeGreaterThan(groupAt);
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

// ── 3. The fence: keyed on money, not on bookkeeping ─────────────────────

describe("the transition fence", () => {
  it("catches a broadcast that BEGAN during the scan (a new row)", async () => {
    fenceInTx = { max_id: "9", row_count: "4", pending_count: "2", confirmed_count: "2" };

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    // Wallets scanned before it and after it were read on opposite sides of a
    // money movement; the group would look perfectly settled and be wrong.
    expect(outcome.reason).toBe("activity_transition");
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it("catches a SETTLEMENT on a pre-existing row - no new id, no new row", async () => {
    // pending -> confirmed: max_id and row_count are unchanged, which is
    // exactly the case `MAX(updated_at)` used to be needed for.
    fenceInTx = { max_id: "7", row_count: "3", pending_count: "0", confirmed_count: "3" };

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("activity_transition");
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it("catches a settle-and-broadcast pair that leaves the pending count level", async () => {
    // One row confirmed while another was inserted pending: pending_count is
    // unchanged, and confirmed_count plus max_id are what catch it.
    fenceInTx = { max_id: "8", row_count: "4", pending_count: "1", confirmed_count: "3" };

    const outcome = await publish();

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("activity_transition");
  });

  it("is NOT tripped by a bookkeeping touch on a still-pending row", async () => {
    // THE DEFECT THIS FIXES. The bridge sweep stamps `updated_at = NOW()` on
    // every attempt - every five minutes, forever, on a row that has not moved
    // - and the old `MAX(updated_at)` component turned that pure re-check into
    // an `activity_transition` skip on a cycle where no money moved. Those
    // writers touch no status and insert nothing, so every component of the
    // new fence is identical across the touch.
    fenceInTx = { max_id: "7", row_count: "3", pending_count: "1", confirmed_count: "2" };
    ledgerRows = [bridgeFill(31 * 24 * 3600)];

    const outcome = await publish();

    expect(outcome.published).toBe(true);
    if (!outcome.published) throw new Error("unreachable");
    expect(outcome.ledger.unresolvedCount).toBe(1);
  });

  it("no longer reads updated_at at all", async () => {
    await publish();
    const fence = statements.find((stmt) => stmt.sql.includes("MAX(id)"));
    expect(fence?.sql).not.toContain("updated_at");
    expect(fence?.sql).toContain("FILTER (WHERE status = 'pending')");
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
    // And no group record: a record whose per-wallet rows do not exist would
    // make the published total unreadable.
    expect(indexOf("INSERT INTO proj_portfolio_snapshot_groups")).toBe(-1);
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

// ── 6. What the published group reports ──────────────────────────────────

describe("the published-group report", () => {
  it("names the settled and in-transit halves and the unresolved count", async () => {
    ledgerRows = [bridgeFill(10 * 60)];

    logPublicationOutcome(await publish(), "group-1");

    expect(mockInfo).toHaveBeenCalledWith(
      "sync.balance.snapshot_published",
      expect.objectContaining({
        snapshotGroupId: "group-1",
        wallets: 2,
        settledUsd: "200.00",
        inTransitUsd: "150.25",
        inFlightCount: 1,
        unresolvedCount: 0,
      }),
    );
    // Nothing is unresolved, so nothing is escalated.
    expect(mockWarn).not.toHaveBeenCalledWith(
      "sync.balance.snapshot_unresolved_money",
      expect.anything(),
    );
  });

  it("reports a skip without pretending anything was recorded", async () => {
    fenceInTx = { max_id: "9", row_count: "4", pending_count: "2", confirmed_count: "2" };

    logPublicationOutcome(await publish(), "group-1");

    expect(mockInfo).toHaveBeenCalledWith(
      "sync.balance.snapshot_deferred",
      expect.objectContaining({ reason: "activity_transition" }),
    );
  });
});
