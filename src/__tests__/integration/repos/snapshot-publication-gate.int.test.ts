/**
 * Integration: the WP8 snapshot publication gate against REAL Postgres.
 *
 * The unit suite (`__tests__/vex-agent/sync/balance-sync-snapshot-publication`)
 * proves OUR ordering - lock before predicate, predicate before insert, insert
 * while the lock is held. It structurally cannot prove the three things that
 * belong to the server, and the whole design rests on them:
 *
 *  1. the seven-branch UNION parses against the real schema and its predicates
 *     match production row shapes (a gate whose fixtures only ever encode the
 *     empty collection proves nothing);
 *  2. `LOCK TABLE agent_activity IN SHARE MODE` genuinely BLOCKS the writer the
 *     gate exists to exclude - Postgres's conflict matrix, not our call order;
 *  3. `SET LOCAL lock_timeout` makes that lock fail with SQLSTATE 55P03, which
 *     `publishSnapshotGroup` maps to `lock_unavailable` instead of failing the
 *     balance refresh.
 *
 * Real SQL, real CHECK constraints, real `NOW()`, real lock waits.
 */

import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import type { PoolClient } from "pg";

import { execute, getPool, queryOne, query } from "@vex-agent/db/client.js";
import {
  readActivityFence,
  readPublicationBlockers,
  type PublicationBlocker,
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

async function insertWalletIntent(
  sessionId: string,
  fields: { status: string; expiresInMs?: number; txHash?: string | null; activityId?: number },
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
    [intentId, sessionId, WALLET, fields.status,
     String(fields.expiresInMs ?? 600_000), fields.txHash ?? null, fields.activityId ?? null],
  );
  return intentId;
}

async function insertTransactionIntent(
  sessionId: string,
  fields: { status: string; expiresInMs?: number; txHash?: string | null; createdAt?: string },
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
    [intentId, sessionId, WALLET, fields.status,
     String(fields.expiresInMs ?? 600_000), fields.txHash ?? null, fields.createdAt ?? null],
  );
  return intentId;
}

async function insertWrapIntent(
  sessionId: string,
  fields: { status: string; expiresInMs?: number; txHash?: string | null },
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
    [intentId, sessionId, WALLET, fields.status,
     String(fields.expiresInMs ?? 600_000), fields.txHash ?? null],
  );
  return intentId;
}

/** Read the gate the way production does: inside a transaction. */
async function blockersNow(): Promise<readonly PublicationBlocker[]> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    return await readPublicationBlockers(client, WALLETS);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

const kindsNow = async () => (await blockersNow()).map((b) => b.kind).sort();

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

let sessionId: string;

beforeEach(async () => {
  await resetDb();
  sessionId = await makeSession();
});

// ── 1. The UNION parses, and every predicate matches a production row ────

describe("the gate SQL against the real schema", () => {
  it("returns nothing for wallets with no money-path rows at all", async () => {
    expect(await blockersNow()).toEqual([]);
  });

  it("blocks on a PENDING agent_activity row", async () => {
    await insertAgentActivity(sessionId, "pending");
    expect(await kindsNow()).toEqual(["agent_activity_pending"]);
  });

  it("does NOT block on terminalized activity", async () => {
    await insertAgentActivity(sessionId, "confirmed");
    await insertAgentActivity(sessionId, "definitively_failed");
    expect(await blockersNow()).toEqual([]);
  });

  it("ignores another wallet's pending activity", async () => {
    await insertAgentActivity(sessionId, "pending", { walletAddress: "0xsomeone-else" });
    expect(await blockersNow()).toEqual([]);
  });

  it("blocks on a live wallet_intent and RELEASES an expired pending one", async () => {
    await insertWalletIntent(sessionId, { status: "consuming" });
    expect(await kindsNow()).toEqual(["wallet_intent_live"]);

    await execute("DELETE FROM wallet_intents");
    // An expired `pending` is dead - `consumeIfPending` filters on
    // `expires_at > NOW()`, so it can never be claimed and must not block forever.
    await insertWalletIntent(sessionId, { status: "pending", expiresInMs: -60_000 });
    expect(await blockersNow()).toEqual([]);
  });

  it("blocks on a wallet_intent whose outcome is unproven", async () => {
    const activityId = await insertAgentActivity(sessionId, "confirmed");
    await insertWalletIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xabc",
      activityId,
    });
    expect(await kindsNow()).toEqual(["wallet_confirmation_unknown"]);
  });

  it("blocks on a live wallet_transaction_intent", async () => {
    await insertTransactionIntent(sessionId, { status: "consuming" });
    expect(await kindsNow()).toEqual(["wallet_transaction_intent_live"]);
  });

  it("blocks on a broadcast-unconfirmed wallet_transaction_intent", async () => {
    await insertTransactionIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xdef",
    });
    expect(await kindsNow()).toEqual(["wallet_transaction_intent_live"]);
  });

  it("releases an executed wallet_transaction_intent", async () => {
    await insertTransactionIntent(sessionId, { status: "executed", txHash: "0xdef" });
    expect(await blockersNow()).toEqual([]);
  });

  it("blocks on a live wallet_wrap_intent, including review_required", async () => {
    await insertWrapIntent(sessionId, { status: "review_required", txHash: "0x123" });
    expect(await kindsNow()).toEqual(["wallet_wrap_intent_live"]);
  });

  it("reports every blocking row at once, across tables", async () => {
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

  it("computes ageSeconds and the unreconciled escalation from real NOW()", async () => {
    await insertTransactionIntent(sessionId, {
      status: "broadcast_unconfirmed",
      txHash: "0xold",
      createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const [blocker] = await blockersNow();
    expect(blocker?.ageSeconds).toBeGreaterThan(15 * 60);
    // Age escalates the report; it never releases publication.
    expect(blocker?.unreconciled).toBe(true);
  });
});

// ── The fence, against real column types ────────────────────────────────

describe("the activity fence", () => {
  it("moves when a row is INSERTED and when a row TRANSITIONS", async () => {
    const before = await readActivityFence(getPool(), WALLETS);

    const id = await insertAgentActivity(sessionId, "pending");
    const afterInsert = await readActivityFence(getPool(), WALLETS);
    expect(afterInsert.maxId).not.toBe(before.maxId);
    expect(afterInsert.rowCount).not.toBe(before.rowCount);

    // A pure status transition on an EXISTING row: max_id and count are
    // unchanged, so only updated_at can catch a transaction that both began
    // and settled during the scan.
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
    expect(afterUpdate.maxUpdatedAt).not.toBe(afterInsert.maxUpdatedAt);
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
  });

  it("writes NOTHING when a pending row appears - real gate, real insert path", async () => {
    const fence = await readActivityFence(getPool(), WALLETS);
    await insertAgentActivity(sessionId, "pending");

    const outcome = await publishSnapshotGroup({
      snapshotGroupId: randomUUID(),
      walletAddresses: WALLETS,
      fenceAtCycleStart: fence,
      drafts: [draft(WALLET)],
    });

    expect(outcome.published).toBe(false);
    if (outcome.published) throw new Error("unreachable");
    // The blocker is found before the fence is even compared.
    expect(outcome.reason).toBe("in_flight_money_state");
    expect(await snapshotCount()).toBe(0);
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
  });
});
