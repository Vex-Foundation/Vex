/**
 * Integration: the snapshot publication gate and its IN-FLIGHT LEDGER against
 * REAL Postgres.
 *
 * The unit suite (`__tests__/vex-agent/sync/balance-sync-snapshot-publication`)
 * proves OUR ordering and OUR arithmetic - lock before ledger, ledger before
 * insert, insert while the lock is held, standing bounds, totals. It
 * structurally cannot prove the four things that belong to the server, and the
 * whole design rests on them:
 *
 *  1. the seven-branch UNION parses against the real schema and both its
 *     predicates AND its money columns match production row shapes (a ledger
 *     whose fixtures only ever encode the empty collection proves nothing);
 *  2. `LOCK TABLE agent_activity IN SHARE MODE` genuinely BLOCKS the writer the
 *     gate exists to exclude - Postgres's conflict matrix, not our call order;
 *  3. `SET LOCAL lock_timeout` makes that lock fail with SQLSTATE 55P03, which
 *     `publishSnapshotGroup` maps to `lock_unavailable` instead of failing the
 *     balance refresh;
 *  4. the group record and the per-wallet rows commit or roll back TOGETHER,
 *     against the real constraints of migration 101.
 *
 * Real SQL, real CHECK constraints, real `NOW()`, real lock waits.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { PoolClient } from "pg";

import { execute, getPool, queryOne, query } from "@vex-agent/db/client.js";
import {
  readActivityFence,
  readInFlightMoney,
  type InFlightEntry,
  type InFlightLedger,
} from "@vex-agent/sync/balance-sync/publication-gate.js";
import { publishSnapshotGroup } from "@vex-agent/sync/balance-sync/snapshot-publication.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

const WALLET = "0xwallet";
const WALLETS = [WALLET];

// ── fixture writers (raw SQL: the gate's contract is with the schema) ────

async function insertProtocolExecution(sessionId: string): Promise<number> {
  const row = await queryOne<{ id: number }>(
    `INSERT INTO protocol_executions
       (tool_id, namespace, session_id, params, result, success, external_refs, execution_status)
     VALUES ('swap_execute', 'agentscan', $1, '{}'::jsonb, '{}'::jsonb, false, '{}'::jsonb, 'succeeded')
     RETURNING id`,
    [sessionId],
  );
  return row?.id ?? 0;
}

async function insertAgentActivity(
  sessionId: string,
  status: "pending" | "confirmed" | "definitively_failed",
  opts: { walletAddress?: string; createdAt?: string } = {},
): Promise<number> {
  const executionId = await insertProtocolExecution(sessionId);
  const row = await queryOne<{ id: number }>(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_role, kind, protocol, chain_id,
        wallet_address, session_id, status, from_address, nonce, tx_hash, confirmed_at,
        executed_amount_in_raw, executed_amount_out_raw, failure_code, created_at)
     VALUES ($1, 'swap', 'swap', 'kyberswap', 8453, $2, $3, $4,
             CASE WHEN $4 = 'pending' THEN NULL ELSE '0xwallet' END,
             CASE WHEN $4 = 'pending' THEN NULL ELSE 1 END,
             CASE WHEN $4 = 'pending' THEN NULL ELSE $5::text END,
             CASE WHEN $4 = 'confirmed' THEN NOW() ELSE NULL END,
             CASE WHEN $4 = 'confirmed' THEN '1' ELSE NULL END,
             CASE WHEN $4 = 'confirmed' THEN '1' ELSE NULL END,
             CASE WHEN $4 = 'definitively_failed' THEN 'unknown' ELSE NULL END,
             COALESCE($6::timestamptz, NOW()))
     RETURNING id`,
    [executionId, opts.walletAddress ?? WALLET, sessionId, status,
     `0xhash-${executionId}`, opts.createdAt ?? null],
  );
  return row?.id ?? 0;
}

/**
 * The owner's row: a cross-chain fill whose provider never conclusively
 * reported. `normalized_route` and `provider_order_id` are constrained to this
 * event role (migration 045), and the money lives on the OUTPUT columns.
 */
async function insertBridgeFill(sessionId: string, walletAddress: string = WALLET): Promise<number> {
  const executionId = await insertProtocolExecution(sessionId);
  const row = await queryOne<{ id: number }>(
    `INSERT INTO agent_activity
       (protocol_execution_id, event_role, kind, protocol, chain_id,
        wallet_address, session_id, status,
        from_chain_id, to_chain_id, chain_family, normalized_route, provider_order_id,
        token_in_symbol, amount_in_human, usd_in_est,
        token_out_symbol, amount_out_human, usd_out_est)
     VALUES ($1, 'bridge_fill_expected', 'bridge', 'khalani', 8453, $2, $3, 'pending',
             8453, 42161, 'eip155', 'base:8453->arbitrum:42161', 'order-132',
             'USDC', '151.0', 151.00,
             'USDC', '150.5', 150.25)
     RETURNING id`,
    [executionId, walletAddress, sessionId],
  );
  return row?.id ?? 0;
}

async function insertWalletIntent(
  sessionId: string,
  fields: {
    status: string;
    expiresInMs?: number;
    txHash?: string | null;
    activityId?: number;
    walletAddress?: string;
  },
): Promise<string> {
  const intentId = randomUUID();
  // `wallet_intents_unconfirmed_evidence` (migration 093) requires BOTH a hash
  // and a linked activity row for `broadcast_unconfirmed` - the schema refuses
  // to record an unproven broadcast with nothing to recover from.
  await execute(
    `INSERT INTO wallet_intents
       (intent_id, session_id, wallet_address, network, to_address, amount,
        preview_json, status, expires_at, tx_hash, activity_id)
     VALUES ($1, $2, $3, 'eip155', '0xdest', '1',
             '{"label":"send","criticalArgs":{}}'::jsonb, $4,
             NOW() + ($5::text || ' milliseconds')::interval, $6, $7)`,
    [intentId, sessionId, fields.walletAddress ?? WALLET, fields.status,
     String(fields.expiresInMs ?? 600_000), fields.txHash ?? null, fields.activityId ?? null],
  );
  return intentId;
}

async function insertTransactionIntent(
  sessionId: string,
  fields: {
    status: string;
    expiresInMs?: number;
    txHash?: string | null;
    createdAt?: string;
    walletAddress?: string;
  },
): Promise<string> {
  const intentId = randomUUID();
  await execute(
    `INSERT INTO wallet_transaction_intents
       (intent_id, session_id, wallet_address, family, chain_alias, chain_id,
        payload_json, decoded_json, preview_json, fee_bounds_json,
        proposal_digest, proposal_digest_version, status, expires_at, tx_hash, created_at)
     VALUES ($1, $2, $3, 'eip155', 'base', 8453,
             '{"to":"0xdest","data":"0x","valueWei":"1"}'::jsonb,
             '{}'::jsonb, '{"label":"tx","criticalArgs":{}}'::jsonb, '{}'::jsonb,
             repeat('b', 64), 'v1', $4,
             NOW() + ($5::text || ' milliseconds')::interval, $6,
             COALESCE($7::timestamptz, NOW()))`,
    [intentId, sessionId, fields.walletAddress ?? WALLET, fields.status,
     String(fields.expiresInMs ?? 600_000), fields.txHash ?? null, fields.createdAt ?? null],
  );
  return intentId;
}

async function insertWrapIntent(
  sessionId: string,
  fields: {
    status: string;
    expiresInMs?: number;
    txHash?: string | null;
    walletAddress?: string;
  },
): Promise<string> {
  const intentId = randomUUID();
  await execute(
    `INSERT INTO wallet_wrap_intents
       (intent_id, session_id, wallet_address, chain_alias, chain_id, direction,
        wrapped_native_address, wrapped_native_symbol, wrapped_native_decimals,
        amount_raw, payload_json, preview_json, fee_bounds_json,
        proposal_digest, proposal_digest_version, status, expires_at, tx_hash)
     VALUES ($1, $2, $3, 'base', 8453, 'wrap',
             '0x4200000000000000000000000000000000000006', 'WETH', 18,
             '1', '{"to":"0x4200000000000000000000000000000000000006",
                    "data":"0xd0e30db0","valueWei":"1"}'::jsonb,
             '{"label":"wrap","criticalArgs":{}}'::jsonb, '{}'::jsonb,
             repeat('a', 64), 'v1', $4,
             NOW() + ($5::text || ' milliseconds')::interval, $6)`,
    [intentId, sessionId, fields.walletAddress ?? WALLET, fields.status,
     String(fields.expiresInMs ?? 600_000), fields.txHash ?? null],
  );
  return intentId;
}

/** Read the ledger the way production does: inside a transaction. */
async function ledgerNow(
  wallets: readonly string[] = WALLETS,
  now: number = Date.now(),
): Promise<InFlightLedger> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    return await readInFlightMoney(client, wallets, now);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function inFlightNow(): Promise<readonly InFlightEntry[]> {
  return (await ledgerNow()).entries;
}

const kindsNow = async () => (await inFlightNow()).map((e) => e.kind).sort();

function draft(address: string) {
  return {
    walletFamily: "eip155",
    walletAddress: address,
    totalUsd: 100,
    positions: { chains: [] },
    activeChains: ["8453"],
  };
}

async function snapshotCount(): Promise<number> {
  const row = await queryOne<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM proj_portfolio_snapshots",
  );
  return Number(row?.n ?? "0");
}

async function groupRecordCount(): Promise<number> {
  const row = await queryOne<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM proj_portfolio_snapshot_groups",
  );
  return Number(row?.n ?? "0");
}

let sessionId: string;

beforeEach(async () => {
  await resetDb();
  sessionId = await makeSession();
});

// ── 1. The UNION parses, and every predicate matches a production row ────

describe("the ledger SQL against the real schema", () => {
  it("returns nothing for wallets with no money-path rows at all", async () => {
    expect(await inFlightNow()).toEqual([]);
  });

  it("records a PENDING agent_activity row", async () => {
    await insertAgentActivity(sessionId, "pending");
    expect(await kindsNow()).toEqual(["agent_activity_pending"]);
  });

  it("records nothing for terminalized activity", async () => {
    await insertAgentActivity(sessionId, "confirmed");
    await insertAgentActivity(sessionId, "definitively_failed");
    expect(await inFlightNow()).toEqual([]);
  });

  it("ignores another wallet's pending activity", async () => {
    await insertAgentActivity(sessionId, "pending", { walletAddress: "0xsomeone-else" });
    expect(await inFlightNow()).toEqual([]);
  });

  it("records a live wallet_intent and OMITS an expired pending one", async () => {
    await insertWalletIntent(sessionId, { status: "consuming" });
    expect(await kindsNow()).toEqual(["wallet_intent_live"]);

    await execute("DELETE FROM wallet_intents");
    // An expired `pending` is dead - `consumeIfPending` filters on
    // `expires_at > NOW()`, so it can never be claimed and must not block forever.
    await insertWalletIntent(sessionId, { status: "pending", expiresInMs: -60_000 });
    expect(await inFlightNow()).toEqual([]);
  });

  it("records a wallet_intent whose outcome is unproven", async () => {
    const activityId = await insertAgentActivity(sessionId, "confirmed");
    await insertWalletIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xabc",
      activityId,
    });
    expect(await kindsNow()).toEqual(["wallet_confirmation_unknown"]);
  });

  it("records a live wallet_transaction_intent", async () => {
    await insertTransactionIntent(sessionId, { status: "consuming" });
    expect(await kindsNow()).toEqual(["wallet_transaction_intent_live"]);
  });

  it("records a broadcast-unconfirmed wallet_transaction_intent", async () => {
    await insertTransactionIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xdef",
    });
    expect(await kindsNow()).toEqual(["wallet_transaction_intent_live"]);
  });

  it("omits an executed wallet_transaction_intent", async () => {
    await insertTransactionIntent(sessionId, { status: "executed", txHash: "0xdef" });
    expect(await inFlightNow()).toEqual([]);
  });

  it("records a live wallet_wrap_intent, including review_required", async () => {
    await insertWrapIntent(sessionId, { status: "review_required", txHash: "0x123" });
    expect(await kindsNow()).toEqual(["wallet_wrap_intent_live"]);
  });

  it("reports every in-flight row at once, across tables", async () => {
    await insertAgentActivity(sessionId, "pending");
    await insertWalletIntent(sessionId, { status: "consuming" });
    await insertTransactionIntent(sessionId, { status: "consuming" });
    await insertWrapIntent(sessionId, { status: "consuming" });
    expect(await kindsNow()).toEqual([
      "agent_activity_pending",
      "wallet_intent_live",
      "wallet_transaction_intent_live",
      "wallet_wrap_intent_live",
    ]);
  });

  it("computes ageSeconds and the standing from real NOW() and real expires_at", async () => {
    await insertTransactionIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xold",
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const [entry] = await inFlightNow();
    expect(entry?.ageSeconds).toBeGreaterThan(15 * 60);
    // 20 minutes is well inside the 2 h bound for a confirmation-unknown row:
    // still on its way, not yet something a human must open.
    expect(entry?.standing).toBe("in_transit");
  });

  it("calls a broadcast-unconfirmed row UNRESOLVED once its 2 h bound has passed", async () => {
    // The real schema is what makes this case worth an integration test: a
    // `broadcast_unconfirmed` row is caught by the LIVE branch, whose default
    // rule is the row's own `expires_at` - and `expires_at` bounds the
    // APPROVAL, which stopped being the relevant clock the moment the
    // transaction left. With an unexpired approval and a three-hour-old
    // broadcast, the two rules disagree, and only the age rule is right.
    await insertTransactionIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xancient",
      expiresInMs: 600_000,
      createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
    });
    const [entry] = await inFlightNow();
    expect(entry?.kind).toBe("wallet_transaction_intent_live");
    expect(entry?.standing).toBe("unresolved");
  });

  it("carries the EXPECTED OUTPUT leg of a bridge fill, priced, from real columns", async () => {
    await insertBridgeFill(sessionId);

    const [entry] = await inFlightNow();

    // The input has already left the wallet, so the money in transit is what is
    // expected to ARRIVE. Read from the real `amount_out_human` /
    // `token_out_symbol` / `usd_out_est` columns of migrations 044 and 045.
    expect(entry).toMatchObject({
      kind: "agent_activity_pending",
      detail: "bridge_fill_expected",
      standing: "in_transit",
      amountHuman: "150.5",
      symbol: "USDC",
      usdEstimate: 150.25,
    });
  });

  it("converts a wrap intent's base units through its real decimals column", async () => {
    await insertWrapIntent(sessionId, { status: "consuming" });

    const [entry] = await inFlightNow();

    // The fixture stores `amount_raw = '1'` at 18 decimals: one wei.
    expect(entry?.amountHuman).toBe("0.000000000000000001");
    expect(entry?.symbol).toBe("WETH");
    // The table carries no price, and "not priced" is not "worth zero".
    expect(entry?.usdEstimate).toBeNull();
  });

  it("reports NULL amounts for a generic transaction intent rather than inventing one", async () => {
    await insertTransactionIntent(sessionId, { status: "consuming" });

    const [entry] = await inFlightNow();

    // `wallet_transaction_intents` is calldata-shaped: it has no amount and no
    // asset column at all, and the ledger says so.
    expect(entry).toMatchObject({ amountHuman: null, symbol: null, usdEstimate: null });
  });
});

// ── 1b. Per-wallet attribution, against the real schema ──────────────────

describe("in-flight money is attributed PER WALLET", () => {
  const OTHER = "0xother-wallet";

  it("gives a scoped read ZERO in transit and NO foreign entry when only the OTHER wallet is pending", async () => {
    // The exact defect: wallet B is mid-bridge, the user opens a scope that
    // holds only wallet A, and B's $150.25 lands in A's portfolio.
    await insertBridgeFill(sessionId, OTHER);

    const scopedToA = await ledgerNow([WALLET]);

    expect(scopedToA.entries).toEqual([]);
    expect(scopedToA.perWallet).toEqual([]);
    expect(scopedToA.totalCount).toBe(0);

    // And the wallet that IS mid-bridge sees exactly its own money.
    const scopedToB = await ledgerNow([OTHER]);
    expect(scopedToB.perWallet).toEqual([
      { walletAddress: OTHER, entryCount: 1, unresolvedCount: 0, inTransitUsd: 150.25 },
    ]);
    expect(scopedToB.entries.map((entry) => entry.walletAddress)).toEqual([OTHER]);
  });

  it("splits a two-wallet scope into two rows, each carrying only its own money", async () => {
    await insertBridgeFill(sessionId, OTHER);
    await insertWalletIntent(sessionId, { status: "consuming" });

    const both = await ledgerNow([WALLET, OTHER]);

    expect(new Map(both.perWallet.map((w) => [w.walletAddress, w.inTransitUsd]))).toEqual(
      new Map([
        // The bridge fill's expected output, priced.
        [OTHER, 150.25],
        // `wallet_intents` carries no USD estimate at all: not priced is not
        // worth zero, and it contributes nothing rather than a fabricated
        // figure.
        [WALLET, 0],
      ]),
    );
    expect(both.totalCount).toBe(2);
    expect(both.entries).toHaveLength(2);
  });

  it("names the owning wallet on EVERY entry, from the row's own column", async () => {
    await insertBridgeFill(sessionId, OTHER);
    await insertTransactionIntent(sessionId, { status: "consuming" });

    const both = await ledgerNow([WALLET, OTHER]);

    expect(new Set(both.entries.map((entry) => entry.walletAddress))).toEqual(
      new Set([WALLET, OTHER]),
    );
  });
});

// ── 1c. Totals over ALL rows; the LIST alone is bounded ──────────────────

describe("the display bound never bounds a total", () => {
  it("counts and prices all 55 rows while listing 50, and says the list is short", async () => {
    // 55 live transaction intents, more than the 50-row display bound.
    for (let i = 0; i < 55; i++) {
      await insertTransactionIntent(sessionId, { status: "consuming" });
    }

    const ledger = await ledgerNow();

    // The list is bounded, and says so.
    expect(ledger.entries).toHaveLength(50);
    expect(ledger.truncated).toBe(true);
    // The accounting is NOT bounded: every row was counted by the server.
    expect(ledger.totalCount).toBe(55);
    expect(ledger.perWallet).toEqual([
      { walletAddress: WALLET, entryCount: 55, unresolvedCount: 0, inTransitUsd: 0 },
    ]);
  });

  it("keeps the OLDEST rows in the bounded list", async () => {
    const oldest = await insertTransactionIntent(sessionId, {
      status: "consuming",
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    for (let i = 0; i < 55; i++) {
      await insertTransactionIntent(sessionId, { status: "consuming" });
    }

    const ledger = await ledgerNow();

    expect(ledger.entries[0]?.ref).toBe(oldest);
    expect(ledger.truncated).toBe(true);
  });

  it("reports an untruncated list as untruncated", async () => {
    await insertTransactionIntent(sessionId, { status: "consuming" });
    const ledger = await ledgerNow();
    expect(ledger.totalCount).toBe(1);
    expect(ledger.truncated).toBe(false);
  });
});

// ── 1d. The standing, decided by the server from the bound table ─────────

describe("the standing bounds, evaluated by real Postgres", () => {
  it("calls a young same-chain leg in transit and an old one unresolved", async () => {
    const id = await insertAgentActivity(sessionId, "pending", {
      createdAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect((await ledgerNow()).entries[0]?.standing).toBe("in_transit");

    await execute("UPDATE agent_activity SET created_at = NOW() - interval '2 hours' WHERE id = $1", [id]);
    const aged = await ledgerNow();
    // Past the one-hour bound for a same-chain leg: listed, counted, and in NO
    // total.
    expect(aged.entries[0]?.standing).toBe("unresolved");
    expect(aged.perWallet[0]?.unresolvedCount).toBe(1);
    expect(aged.perWallet[0]?.inTransitUsd).toBe(0);
  });

  it("gives a bridge fill the two-hour bound its detail override names", async () => {
    const id = await insertBridgeFill(sessionId);
    await execute("UPDATE agent_activity SET created_at = NOW() - interval '90 minutes' WHERE id = $1", [id]);

    const ledger = await ledgerNow();

    // 90 minutes is past the same-chain hour and inside the cross-chain two,
    // so this row proves the OVERRIDE is applied and not the kind's default.
    expect(ledger.entries[0]?.standing).toBe("in_transit");
    expect(ledger.perWallet[0]?.inTransitUsd).toBeCloseTo(150.25, 6);
  });

  it("uses the row's OWN expiry for a claimable proposal, not its age", async () => {
    await insertWalletIntent(sessionId, { status: "consuming", expiresInMs: -1_000 });
    // Seconds old, and already dead: the CAS filters on `expires_at > NOW()`.
    expect((await ledgerNow()).entries[0]?.standing).toBe("unresolved");

    await execute("DELETE FROM wallet_intents");
    await insertWalletIntent(sessionId, { status: "consuming", expiresInMs: 600_000 });
    expect((await ledgerNow()).entries[0]?.standing).toBe("in_transit");
  });

  it("counts an unresolved row without letting its estimate reach any total", async () => {
    const id = await insertBridgeFill(sessionId);
    await execute("UPDATE agent_activity SET created_at = NOW() - interval '3 hours' WHERE id = $1", [id]);

    const ledger = await ledgerNow();

    expect(ledger.entries[0]?.standing).toBe("unresolved");
    // The entry keeps its estimate for the operator to read; the accounting
    // refuses it in either direction.
    expect(ledger.entries[0]?.usdEstimate).toBeCloseTo(150.25, 6);
    expect(ledger.perWallet[0]).toEqual({
      walletAddress: WALLET,
      entryCount: 1,
      unresolvedCount: 1,
      inTransitUsd: 0,
    });
  });

  it("reads a NEGATIVE estimate as not priced, in the entry AND in the total", async () => {
    const id = await insertBridgeFill(sessionId);
    await execute("UPDATE agent_activity SET usd_out_est = -500 WHERE id = $1", [id]);

    const ledger = await ledgerNow();

    // A negative estimate is a bad price, not a liability. It must not
    // subtract from a portfolio on either path.
    expect(ledger.entries[0]?.usdEstimate).toBeNull();
    expect(ledger.perWallet[0]?.inTransitUsd).toBe(0);
  });
});

// ── 1e. The documented exception: expired, unbroadcast, never in flight ──

describe("an expired PENDING intent with no transaction hash", () => {
  /**
   * The owner's exception (2026-09-04), asserted as a table over all three
   * intent tables: such a row is not listed at all, in either standing. The
   * proposal can never be claimed (`expires_at > NOW()` in the consuming CAS)
   * and nothing was ever broadcast, so no money left and there is no outcome
   * for anyone to prove. Listing it as `unresolved` would tell a human money is
   * unaccounted for when none ever moved.
   */
  const EXPIRED_PENDING: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ["wallet_intents", () => insertWalletIntent(sessionId, { status: "pending", expiresInMs: -60_000 })],
    ["wallet_transaction_intents", () => insertTransactionIntent(sessionId, { status: "pending", expiresInMs: -60_000 })],
    ["wallet_wrap_intents", () => insertWrapIntent(sessionId, { status: "pending", expiresInMs: -60_000 })],
  ];

  it.each(EXPIRED_PENDING)("%s: is not listed, not counted, and in no total", async (_table, insert) => {
    await insert();

    const ledger = await ledgerNow();

    expect(ledger.entries).toEqual([]);
    expect(ledger.perWallet).toEqual([]);
    expect(ledger.totalCount).toBe(0);
  });

  /**
   * The other half of the exception, and the reason it is safe: the moment a
   * row carries a hash, expiry stops being the relevant clock. Expiry bounds
   * the APPROVAL; the transaction has already left.
   */
  const BROADCAST_PAST_EXPIRY: ReadonlyArray<readonly [string, () => Promise<unknown>, string]> = [
    [
      "wallet_transaction_intents",
      () => insertTransactionIntent(sessionId, {
        status: "broadcast_unconfirmed",
        txHash: "0xbroadcast-tx",
        expiresInMs: -60_000,
      }),
      "wallet_transaction_intent_live",
    ],
    [
      "wallet_wrap_intents",
      () => insertWrapIntent(sessionId, {
        status: "broadcast_unconfirmed",
        txHash: "0xbroadcast-wrap",
        expiresInMs: -60_000,
      }),
      "wallet_wrap_intent_live",
    ],
  ];

  it.each(BROADCAST_PAST_EXPIRY)(
    "%s: a BROADCAST row past its expiry is still listed",
    async (_table, insert, kind) => {
      await insert();

      const ledger = await ledgerNow();

      expect(ledger.entries.map((entry) => entry.kind)).toEqual([kind]);
      expect(ledger.totalCount).toBe(1);
    },
  );

  it("wallet_intents: a broadcast row past its expiry is still listed", async () => {
    const activityId = await insertAgentActivity(sessionId, "confirmed");
    await insertWalletIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xbroadcast-intent",
      activityId,
      expiresInMs: -60_000,
    });

    const ledger = await ledgerNow();

    expect(ledger.entries.map((entry) => entry.kind)).toEqual(["wallet_confirmation_unknown"]);
    expect(ledger.totalCount).toBe(1);
  });
});

// ── The fence, against real column types ────────────────────────────────

describe("the activity fence", () => {
  it("moves when a row is INSERTED and when a row SETTLES", async () => {
    const before = await readActivityFence(getPool(), WALLETS);

    const id = await insertAgentActivity(sessionId, "pending");
    const afterInsert = await readActivityFence(getPool(), WALLETS);
    expect(afterInsert.maxId).not.toBe(before.maxId);
    expect(afterInsert.rowCount).not.toBe(before.rowCount);
    expect(afterInsert.pendingCount).not.toBe(before.pendingCount);

    // A pure status transition on an EXISTING row: max_id and row_count are
    // unchanged, and the per-status counts are what catch a transaction that
    // both began and settled during the scan.
    await execute(
      `UPDATE agent_activity
          SET status = 'confirmed', tx_hash = '0xh', confirmed_at = NOW(),
              executed_amount_in_raw = '1', executed_amount_out_raw = '1',
              from_address = '0xwallet', nonce = 1, updated_at = NOW() + interval '1 second'
        WHERE id = $1`,
      [id],
    );
    const afterUpdate = await readActivityFence(getPool(), WALLETS);
    expect(afterUpdate.maxId).toBe(afterInsert.maxId);
    expect(afterUpdate.rowCount).toBe(afterInsert.rowCount);
    expect(afterUpdate.pendingCount).not.toBe(afterInsert.pendingCount);
    expect(afterUpdate.confirmedCount).not.toBe(afterInsert.confirmedCount);
  });

  it("does NOT move for a bridge-sweep bookkeeping touch on a pending row", async () => {
    const id = await insertBridgeFill(sessionId);
    const before = await readActivityFence(getPool(), WALLETS);

    // The exact write the sweep's candidate claim performs every five minutes,
    // forever, on a row that has not moved
    // (`bridge-activity-repair-production-deps.ts`), plus the verification
    // bookkeeping's own columns. Under the previous `MAX(updated_at)` fence
    // this tripped `activity_transition` on a cycle where no money moved.
    await execute(
      `UPDATE agent_activity
          SET last_attempted_at = NOW(),
              updated_at = NOW() + interval '5 minutes',
              last_checked_at = NOW(),
              verification_attempts = verification_attempts + 1,
              last_verification_reason = 'provider_unreachable',
              provider_status = 'published'
        WHERE id = $1`,
      [id],
    );

    expect(await readActivityFence(getPool(), WALLETS)).toEqual(before);
  });
});

// ── 2. The lock really blocks the writer ────────────────────────────────

describe("LOCK TABLE agent_activity IN SHARE MODE", () => {
  it("BLOCKS a concurrent agent_activity writer until the holder commits", async () => {
    const executionId = await insertProtocolExecution(sessionId);

    const holder: PoolClient = await getPool().connect();
    const writer: PoolClient = await getPool().connect();
    const order: string[] = [];
    try {
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE agent_activity IN SHARE MODE");

      // A real ROW EXCLUSIVE writer - exactly what a broadcast does.
      const write = writer
        .query(
          `INSERT INTO agent_activity
             (protocol_execution_id, event_role, kind, protocol, chain_id,
              wallet_address, session_id, status)
           VALUES ($1, 'swap', 'swap', 'kyberswap', 8453, $2, $3, 'pending')`,
          [executionId, WALLET, sessionId],
        )
        .then(() => order.push("writer_inserted"));

      // Proof it is WAITING, taken from the server rather than from a timer:
      // pg_stat_activity shows the backend blocked on a relation lock.
      await waitForBlockedBackend();
      expect(order).toEqual([]);

      order.push("holder_committed");
      await holder.query("COMMIT");
      await write;
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
      writer.release();
    }

    // Strict order, never an interleaving: the writer's row could not land
    // while the gate held the table, so "nothing is pending" stayed true from
    // the predicate until COMMIT.
    expect(order).toEqual(["holder_committed", "writer_inserted"]);
  });
});

/** Poll the server for a backend genuinely waiting on a lock. */
async function waitForBlockedBackend(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active'`,
    );
    if (Number(rows[0]?.n ?? "0") > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no backend ever blocked on a lock - the LOCK did not conflict");
}

// ── 3. lock_timeout → 55P03 → lock_unavailable ──────────────────────────

describe("publishSnapshotGroup against a contended table", () => {
  it("skips with lock_unavailable when the lock times out, writing NOTHING", async () => {
    // ACCESS EXCLUSIVE conflicts with our SHARE, so the publisher must wait -
    // and its own `SET LOCAL lock_timeout` must cut that wait short with 55P03.
    // Stamped BEFORE the blocker takes the table: the fence read is a plain
    // SELECT needing ACCESS SHARE, which ACCESS EXCLUSIVE also blocks, and it
    // carries no timeout of its own. In production it runs at cycle start, long
    // before publication - this ordering is the harness matching that, not a
    // convenience.
    const fence = await readActivityFence(getPool(), WALLETS);

    const blocker: PoolClient = await getPool().connect();
    let outcome: Awaited<ReturnType<typeof publishSnapshotGroup>>;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE agent_activity IN ACCESS EXCLUSIVE MODE");

      outcome = await publishSnapshotGroup({
        snapshotGroupId: randomUUID(),
        walletAddresses: WALLETS,
        fenceAtCycleStart: fence,
        drafts: [draft(WALLET)],
        lockTimeoutMs: 250,
      });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    // Not `publish_failed`: a busy money path is not a defect, and it must not
    // fail the balance refresh.
    expect(outcome.reason).toBe("lock_unavailable");
    expect(await snapshotCount()).toBe(0);
    expect(await groupRecordCount()).toBe(0);
  });

  it("SET LOCAL lock_timeout really raises SQLSTATE 55P03 on the LOCK", async () => {
    // The mapping in `skipOnError` is only worth anything if this is the code
    // Postgres actually raises. Asserted directly, not inferred.
    const blocker: PoolClient = await getPool().connect();
    const waiter: PoolClient = await getPool().connect();
    let code: string | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE agent_activity IN ACCESS EXCLUSIVE MODE");
      await waiter.query("BEGIN");
      await waiter.query("SET LOCAL lock_timeout = 250");
      try {
        await waiter.query("LOCK TABLE agent_activity IN SHARE MODE");
      } catch (err) {
        code = (err as { code?: string }).code;
      }
    } finally {
      await waiter.query("ROLLBACK").catch(() => undefined);
      await blocker.query("ROLLBACK").catch(() => undefined);
      waiter.release();
      blocker.release();
    }
    expect(code).toBe("55P03");
  });

  it("publishes the WHOLE group once the table is free", async () => {
    const fence = await readActivityFence(getPool(), WALLETS);
    const groupId = randomUUID();

    const outcome = await publishSnapshotGroup({
      snapshotGroupId: groupId,
      walletAddresses: WALLETS,
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET), draft("0xsecond")],
    });

    expect(outcome.published).toBe(true);
    expect(await snapshotCount()).toBe(2);
    const rows = await query<{ snapshot_group_id: string }>(
      "SELECT snapshot_group_id FROM proj_portfolio_snapshots",
    );
    expect(new Set(rows.map((r) => r.snapshot_group_id))).toEqual(new Set([groupId]));
    // And exactly one record for that group, with an empty ledger.
    expect(await groupRecordCount()).toBe(1);
    const group = await queryOne<{ in_transit_usd: string; in_flight: unknown[] }>(
      "SELECT in_transit_usd::text, in_flight FROM proj_portfolio_snapshot_groups",
    );
    expect(Number(group?.in_transit_usd)).toBe(0);
    expect(group?.in_flight).toEqual([]);
  });

  it("publishes WITH a pending bridge row, and records it - real ledger, real insert path", async () => {
    await insertBridgeFill(sessionId);
    // Stamped AFTER the row exists: the row was already in flight when the
    // cycle began, which is the owner's case. A row that appears DURING the
    // scan is a fence violation and is covered by the next test.
    const fence = await readActivityFence(getPool(), WALLETS);
    const groupId = randomUUID();

    const outcome = await publishSnapshotGroup({
      snapshotGroupId: groupId,
      walletAddresses: WALLETS,
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET)],
    });

    expect(outcome.published).toBe(true);
    expect(await snapshotCount()).toBe(1);

    // The group record, read back from the real table with its real types.
    const group = await queryOne<{
      settled_usd: string;
      in_transit_usd: string;
      unresolved_count: number;
      in_flight_total_count: number;
      in_flight: Array<Record<string, unknown>>;
    }>(
      `SELECT settled_usd::text, in_transit_usd::text, unresolved_count,
              in_flight_total_count, in_flight
         FROM proj_portfolio_snapshot_groups WHERE snapshot_group_id = $1`,
      [groupId],
    );
    expect(Number(group?.settled_usd)).toBeCloseTo(100, 6);
    expect(Number(group?.in_transit_usd)).toBeCloseTo(150.25, 6);
    expect(group?.unresolved_count).toBe(0);
    // The rows FOUND, beside the rows stored: a reader compares the two to
    // know whether it holds the whole list.
    expect(group?.in_flight_total_count).toBe(1);
    expect(group?.in_flight).toHaveLength(1);
    expect(group?.in_flight[0]).toMatchObject({
      kind: "agent_activity_pending",
      walletAddress: WALLET,
      detail: "bridge_fill_expected",
      standing: "in_transit",
      amountHuman: "150.5",
      symbol: "USDC",
    });

    // And the per-wallet attribution (migration 102), against the real table
    // and its real CHECK constraints.
    const perWallet = await query<{
      wallet_address: string;
      entry_count: number;
      unresolved_count: number;
      in_transit_usd: string;
    }>(
      `SELECT wallet_address, entry_count, unresolved_count, in_transit_usd::text
         FROM proj_portfolio_snapshot_group_wallets WHERE snapshot_group_id = $1`,
      [groupId],
    );
    expect(perWallet).toHaveLength(1);
    expect(perWallet[0]?.wallet_address).toBe(WALLET);
    expect(perWallet[0]?.entry_count).toBe(1);
    expect(perWallet[0]?.unresolved_count).toBe(0);
    expect(Number(perWallet[0]?.in_transit_usd)).toBeCloseTo(150.25, 6);
  });

  it("attributes ONE wallet's pending bridge to that wallet alone in the durable record", async () => {
    const other = "0xother-wallet";
    await insertBridgeFill(sessionId, other);
    const fence = await readActivityFence(getPool(), [WALLET, other]);
    const groupId = randomUUID();

    const outcome = await publishSnapshotGroup({
      snapshotGroupId: groupId,
      walletAddresses: [WALLET, other],
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET), draft(other)],
    });

    expect(outcome.published).toBe(true);
    const perWallet = await query<{ wallet_address: string; in_transit_usd: string }>(
      `SELECT wallet_address, in_transit_usd::text
         FROM proj_portfolio_snapshot_group_wallets WHERE snapshot_group_id = $1`,
      [groupId],
    );
    // Exactly ONE row: the wallet with nothing in flight has nothing recorded,
    // which is what lets a scoped read for it sum to zero instead of
    // inheriting the group figure.
    expect(perWallet).toEqual([
      expect.objectContaining({ wallet_address: other }),
    ]);
    expect(Number(perWallet[0]?.in_transit_usd)).toBeCloseTo(150.25, 6);
  });

  it("refuses a negative per-wallet in-transit total at the SCHEMA, not only in code", async () => {
    const fence = await readActivityFence(getPool(), WALLETS);
    const groupId = randomUUID();
    await publishSnapshotGroup({
      snapshotGroupId: groupId,
      walletAddresses: WALLETS,
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET)],
    });

    // The durable floor: money in transit is never negative, and the
    // database is the last place that can be told otherwise.
    await expect(
      execute(
        `INSERT INTO proj_portfolio_snapshot_group_wallets
           (snapshot_group_id, wallet_address, entry_count, unresolved_count, in_transit_usd)
         VALUES ($1::uuid, $2, 1, 0, -1)`,
        [groupId, WALLET],
      ),
    ).rejects.toThrow(/in_transit_usd_check/);
  });

  it("writes NO group record when a per-wallet insert fails", async () => {
    const fence = await readActivityFence(getPool(), WALLETS);
    const groupId = randomUUID();

    // `wallet_family` is CHECKed against ('eip155','solana') by migration 027,
    // so the second draft's insert is refused by the SERVER - a real failure
    // mid-group, not a stubbed one.
    const outcome = await publishSnapshotGroup({
      snapshotGroupId: groupId,
      walletAddresses: WALLETS,
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET), { ...draft("0xsecond"), walletFamily: "not_a_family" }],
    });

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("publish_failed");
    // Whole group or none, the record included: a record whose per-wallet rows
    // do not exist would make the published total unreadable.
    expect(await snapshotCount()).toBe(0);
    expect(await groupRecordCount()).toBe(0);
  });

  it("refuses when the activity generation moved during the scan", async () => {
    const fence = await readActivityFence(getPool(), WALLETS);
    // Began AND settled while we were scanning: nothing is pending now.
    await insertAgentActivity(sessionId, "confirmed");

    const outcome = await publishSnapshotGroup({
      snapshotGroupId: randomUUID(),
      walletAddresses: WALLETS,
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET)],
    });

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    expect(outcome.reason).toBe("activity_transition");
    expect(await snapshotCount()).toBe(0);
    expect(await groupRecordCount()).toBe(0);
  });
});
