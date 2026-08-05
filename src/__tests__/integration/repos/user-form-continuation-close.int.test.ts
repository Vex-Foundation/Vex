/**
 * A2's durable half, against a REAL Postgres — because all three guarantees are
 * SQL, and one of them is a CHECK constraint TypeScript cannot enforce.
 *
 * 1. **A closed continuation leaves the outstanding set permanently.** That set
 *    is what the sweep retries; if closure did not remove the row, the 60s warn
 *    loop the closure exists to end would simply continue.
 * 2. **The closure is write-once.** A real completed turn wins the CAS, and its
 *    row must never be relabelled as a failure.
 * 3. **`isSessionResumable` distinguishes MISSING from SOFT-DELETED from live.**
 *    The live orphan was soft-deleted, and `isSessionSoftDeleted` answers
 *    `false` for a row that does not exist at all — the opposite of what a
 *    resume needs to hear.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "pg";

import { afterEach, describe, expect, it } from "vitest";

import { execute, getPool, queryOne } from "@vex-agent/db/client.js";
import { isSessionResumable } from "@vex-agent/db/repos/sessions.js";
import {
  casCloseUserFormContinuationWith,
  casMarkUserFormResumeConsumedWith,
  createWith,
  listOutstandingUserFormResumes,
} from "@vex-agent/db/repos/token-launch-intents.js";

const CHAIN_ID = 4663;
const WALLET = "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA";

const createdIntentIds: string[] = [];
const createdSessionIds: string[] = [];

afterEach(async () => {
  if (createdIntentIds.length > 0) {
    const ids = createdIntentIds.splice(0, createdIntentIds.length);
    await execute(`DELETE FROM token_launch_intents WHERE intent_id = ANY($1::text[])`, [ids]);
  }
  if (createdSessionIds.length > 0) {
    const ids = createdSessionIds.splice(0, createdSessionIds.length);
    await execute(`DELETE FROM sessions WHERE id = ANY($1::text[])`, [ids]);
  }
});

async function seedSession(): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (id) VALUES (gen_random_uuid()::text) RETURNING id`,
  );
  if (!row) throw new Error("failed to seed a session");
  createdSessionIds.push(row.id);
  return row.id;
}

/**
 * A parked `agent_requested_form` intent whose form has EXPIRED — the shape the
 * durable floor actually owns. A still-live form is deliberately not
 * outstanding: there is nothing honest to tell the model while the human can
 * still fill it in.
 */
async function seedParkedIntent(sessionId: string): Promise<string> {
  const intentId = `cc-${randomUUID()}`;
  const client = await getPool().connect();
  try {
    await createWith(client, {
      intentId,
      sessionId,
      origin: "agent_requested_form",
      status: "awaiting_user_form",
      chainId: CHAIN_ID,
      walletAddress: WALLET,
      name: "Continuation",
      symbol: "CONT",
      toolCallId: `call-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
  } finally {
    client.release();
  }
  createdIntentIds.push(intentId);
  await execute(
    `UPDATE token_launch_intents SET status = 'expired' WHERE intent_id = $1`,
    [intentId],
  );
  return intentId;
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function isOutstanding(intentId: string): Promise<boolean> {
  const rows = await listOutstandingUserFormResumes(200);
  return rows.some((row) => row.intentId === intentId);
}

describe("closing a continuation that can never complete", () => {
  it("retires it from the outstanding set with its reason recorded", async () => {
    const sessionId = await seedSession();
    const intentId = await seedParkedIntent(sessionId);
    expect(await isOutstanding(intentId)).toBe(true);

    const closed = await withClient((client) =>
      casCloseUserFormContinuationWith(client, intentId, sessionId, "session_deleted"));

    expect(closed).toBe(true);
    expect(await isOutstanding(intentId)).toBe(false);

    const row = await queryOne<{ resume_closed_reason: string; resume_consumed_at: Date }>(
      `SELECT resume_closed_reason, resume_consumed_at FROM token_launch_intents WHERE intent_id = $1`,
      [intentId],
    );
    expect(row?.resume_closed_reason).toBe("session_deleted");
    // The reason is never orphaned from the fact — one write, both columns.
    expect(row?.resume_consumed_at).not.toBeNull();
  });

  it("never relabels a continuation whose turn actually completed", async () => {
    const sessionId = await seedSession();
    const intentId = await seedParkedIntent(sessionId);

    const consumed = await withClient((client) =>
      casMarkUserFormResumeConsumedWith(client, intentId, sessionId));
    expect(consumed).toBe(true);

    const closed = await withClient((client) =>
      casCloseUserFormContinuationWith(client, intentId, sessionId, "resume_failed_deterministic"));

    expect(closed).toBe(false);
    const row = await queryOne<{ resume_closed_reason: string | null }>(
      `SELECT resume_closed_reason FROM token_launch_intents WHERE intent_id = $1`,
      [intentId],
    );
    expect(row?.resume_closed_reason).toBeNull();
  });

  it("refuses a reason outside the closed vocabulary", async () => {
    const sessionId = await seedSession();
    const intentId = await seedParkedIntent(sessionId);

    // The CHECK in migration 070, exercised directly: a reason nobody can
    // decode is worse than none, so the database refuses it even if a future
    // caller bypasses the TypeScript union.
    await expect(
      execute(
        `UPDATE token_launch_intents SET resume_closed_reason = 'whatever' WHERE intent_id = $1`,
        [intentId],
      ),
    ).rejects.toThrow(/resume_closed_reason/);
  });

  it("leaves the LAUNCH untouched — a closed continuation is not a launch outcome", async () => {
    const sessionId = await seedSession();
    const intentId = await seedParkedIntent(sessionId);

    await withClient((client) =>
      casCloseUserFormContinuationWith(client, intentId, sessionId, "session_deleted"));

    const row = await queryOne<{ status: string; tx_hash: string | null }>(
      `SELECT status, tx_hash FROM token_launch_intents WHERE intent_id = $1`,
      [intentId],
    );
    expect(row?.status).toBe("expired");
    expect(row?.tx_hash).toBeNull();
  });
});

describe("isSessionResumable", () => {
  it("says yes for a live session", async () => {
    const sessionId = await seedSession();
    expect(await isSessionResumable(sessionId)).toBe(true);
  });

  it("says NO for a soft-deleted session — the live orphan's exact state", async () => {
    const sessionId = await seedSession();
    await execute(`UPDATE sessions SET deleted_at = NOW() WHERE id = $1`, [sessionId]);

    expect(await isSessionResumable(sessionId)).toBe(false);
  });

  it("says NO for a session that does not exist at all", async () => {
    expect(await isSessionResumable(`missing-${randomUUID()}`)).toBe(false);
  });
});
