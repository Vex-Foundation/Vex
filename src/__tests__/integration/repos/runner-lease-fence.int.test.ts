/**
 * Kairos S-1 lease fencing on a real (disposable, testcontainers) Postgres:
 *
 *   - migration 173: `runner_leases.claim_token` exists, NOT NULL, defaulted;
 *   - the token contract: a new token per new claim, kept on renewal and on a
 *     token-presenting refresh, a fresh one on an expired takeover; a
 *     same-owner claim WITHOUT the token is busy while the lease is live;
 *   - renew / release / fenced writes require the token: two runners with the
 *     SAME owner id, only the token holder renews, releases or writes;
 *   - the FOR SHARE fence: a takeover issued while a fenced write transaction
 *     is open WAITS for it; after the takeover the stale runner's fenced write
 *     affects zero rows and does not throw.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const client = await import("@vex-agent/db/client.js");
const leases = await import("@vex-agent/db/repos/runner-leases.js");
const fence = await import("@vex-agent/db/lease-fence.js");
const guardModule = await import("@vex-agent/engine/runtime/lease-guard.js");
const events = await import("@vex-agent/engine/events/index.js");
const { addMessageReturningId } = await import("@vex-agent/db/repos/messages.js");

const TTL_MS = 60_000;

async function newSession(): Promise<string> {
  const rows = await client.query<{ id: string }>(
    `INSERT INTO sessions (id) VALUES (gen_random_uuid()::text) RETURNING id`,
  );
  const row = rows[0];
  if (row === undefined) throw new Error("session insert returned no row");
  return row.id;
}

async function expireLease(sessionId: string): Promise<void> {
  await client.execute(
    `UPDATE runner_leases SET expires_at = NOW() - interval '1 second' WHERE session_id = $1`,
    [sessionId],
  );
}

async function messageCount(sessionId: string): Promise<number> {
  const rows = await client.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM messages WHERE session_id = $1`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? "0");
}

async function claim(sessionId: string, ownerId: string, claimToken?: string) {
  return leases.acquireLease({
    sessionId,
    ownerId,
    processKind: "test",
    ttlMs: TTL_MS,
    ...(claimToken === undefined ? {} : { claimToken }),
  });
}

function requireLease<T>(value: T | null): T {
  if (value === null) throw new Error("expected a lease");
  return value;
}

describe("S-1 lease fencing on a disposable Postgres", () => {
  beforeAll(() => {
    client.getPool();
  });

  afterAll(async () => {
    await client.closePool();
  });

  it("migration 173 adds a NOT NULL, defaulted claim_token", async () => {
    // Disposable testcontainers database only - never the owner's app DB.
    const db = await client.query<{ name: string }>(`SELECT current_database() AS name`);
    expect(db[0]?.name).toBe("vex_test");
    const rows = await client.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'runner_leases' AND column_name = 'claim_token'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("NO");
    expect(rows[0]?.column_default ?? "").toContain("gen_random_uuid");
  });

  it("issues a token per new claim, keeps it on renewal and refresh, and mints a new one on takeover", async () => {
    const sessionId = await newSession();
    const first = requireLease(await claim(sessionId, "retry-run-x"));
    expect(first.claimToken).toMatch(/[0-9a-f-]{36}/);
    expect(first.tookOver).toBeUndefined();

    const renewed = requireLease(await leases.renewLease(sessionId, first.claimToken, TTL_MS));
    expect(renewed.claimToken).toBe(first.claimToken);

    // Same owner WITHOUT the token while live: busy (the fixed-owner-id hole).
    expect(await claim(sessionId, "retry-run-x")).toBeNull();
    // Same owner WITH the token: an idempotent refresh that keeps the token.
    const refreshed = requireLease(await claim(sessionId, "retry-run-x", first.claimToken));
    expect(refreshed.claimToken).toBe(first.claimToken);
    expect(refreshed.tookOver).toBeUndefined();
    // A different owner while live: busy.
    expect(await claim(sessionId, "someone-else")).toBeNull();

    await expireLease(sessionId);
    const takeover = requireLease(await claim(sessionId, "retry-run-x"));
    expect(takeover.claimToken).not.toBe(first.claimToken);
    expect(takeover.tookOver).toBe(true);
  });

  it("two runners with the SAME owner id: only the token holder renews, releases or writes", async () => {
    const sessionId = await newSession();
    const old = requireLease(await claim(sessionId, "wake-executor-w1"));
    await expireLease(sessionId);
    const current = requireLease(await claim(sessionId, "wake-executor-w1"));
    expect(current.ownerId).toBe(old.ownerId);

    expect(await leases.renewLease(sessionId, old.claimToken, TTL_MS)).toBeNull();
    expect(await leases.releaseLease(sessionId, old.claimToken)).toBe(0);
    expect(await leases.getLease(sessionId)).not.toBeNull();

    // Writes follow the token too: the same owner id without the current
    // token is refused by the fence (zero rows), the token holder's lands.
    const write = (claimToken: string, content: string) =>
      fence.withLeaseFence(
        { sessionId, claimToken },
        async (tx) =>
          addMessageReturningId(
            sessionId,
            { role: "assistant", content, timestamp: new Date().toISOString() },
            { source: "assistant", messageType: "chat", visibility: "user" },
            tx,
          ),
        { site: "tool_batch_transcript" },
      );
    expect(await write(old.claimToken, "stale same-owner write")).toEqual({
      fenced: false,
      state: "taken_over",
    });
    expect(await messageCount(sessionId)).toBe(0);
    expect((await write(current.claimToken, "token holder write")).fenced).toBe(true);
    expect(await messageCount(sessionId)).toBe(1);

    expect(await leases.renewLease(sessionId, current.claimToken, TTL_MS)).not.toBeNull();
    expect(await leases.releaseLease(sessionId, current.claimToken)).toBe(1);
    expect(await leases.getLease(sessionId)).toBeNull();
  });

  it("a takeover WAITS for an open fenced write; the stale write afterwards affects zero rows", async () => {
    const sessionId = await newSession();
    const a = requireLease(await claim(sessionId, "runner-a"));
    await expireLease(sessionId);
    const fenceA = { sessionId, claimToken: a.claimToken };

    // Runner A opens a fenced write and holds the transaction open.
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let fenceEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      fenceEntered = resolve;
    });
    const fencedWrite = fence.withLeaseFence(
      fenceA,
      async (tx) => {
        fenceEntered();
        await gate;
        return addMessageReturningId(
          sessionId,
          { role: "assistant", content: "written under A", timestamp: new Date().toISOString() },
          { source: "assistant", messageType: "chat", visibility: "user" },
          tx,
        );
      },
      { site: "tool_batch_transcript" },
    );
    await entered;

    // Runner B tries to take the expired lease while A's share lock is held.
    let stealSettled = false;
    const steal = claim(sessionId, "runner-b").then((lease) => {
      stealSettled = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stealSettled).toBe(false);

    // The steal really is blocked on a lock, not merely slow.
    const waiting = await client.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND query LIKE 'INSERT INTO runner_leases%'`,
    );
    expect(Number(waiting[0]?.n ?? "0")).toBeGreaterThanOrEqual(1);

    releaseGate();
    const aOutcome = await fencedWrite;
    expect(aOutcome.fenced).toBe(true);
    const b = requireLease(await steal);
    expect(b.claimToken).not.toBe(a.claimToken);
    expect(b.tookOver).toBe(true);
    expect(await messageCount(sessionId)).toBe(1);

    // After the takeover, A's next fenced write is refused: zero rows, no throw.
    const stale = await fence.withLeaseFence(
      fenceA,
      async (tx) =>
        addMessageReturningId(
          sessionId,
          { role: "assistant", content: "stale", timestamp: new Date().toISOString() },
          { source: "assistant", messageType: "chat", visibility: "user" },
          tx,
        ),
      { site: "tool_batch_transcript" },
    );
    expect(stale).toEqual({ fenced: false, state: "taken_over" });
    expect(await messageCount(sessionId)).toBe(1);

    // The runner-level path: the batch append returns null, writes nothing,
    // and marks the stale runner's guard lost (taken over).
    const guardA = guardModule.createRunnerLeaseGuard({ ownerId: "runner-a", fence: fenceA });
    const appended = await events.appendMessagesUnderLease(
      sessionId,
      [
        {
          msg: { role: "assistant", content: "stale batch", timestamp: new Date().toISOString() },
          metadata: { source: "assistant", messageType: "chat", visibility: "user" },
        },
        {
          msg: { role: "tool", content: "stale result", toolCallId: "c1", timestamp: new Date().toISOString() },
          metadata: { source: "tool", messageType: "tool_result", visibility: "internal" },
        },
      ],
      guardA,
      "tool_batch_transcript",
    );
    expect(appended).toBeNull();
    expect(guardA.lostReason()).toBe("taken_over");
    expect(guardA.lostSignal.aborted).toBe(true);
    expect(await messageCount(sessionId)).toBe(1);

    // And the pre-dispatch token check refuses a NEW call for A, allows B.
    expect(await guardModule.leaseHeldForDispatch(
      guardModule.createRunnerLeaseGuard({ ownerId: "runner-a", fence: fenceA }),
    )).toBe(false);
    expect(await guardModule.leaseHeldForDispatch(
      guardModule.createRunnerLeaseGuard({
        ownerId: "runner-b",
        fence: { sessionId, claimToken: b.claimToken },
      }),
    )).toBe(true);
  });

  it("a released lease (e.g. deleted by an operator Stop) still admits the stopped turn's closing write", async () => {
    const sessionId = await newSession();
    const a = requireLease(await claim(sessionId, "runner-a"));
    await client.execute(`DELETE FROM runner_leases WHERE session_id = $1`, [sessionId]);
    const outcome = await fence.withLeaseFence(
      { sessionId, claimToken: a.claimToken },
      async (tx) =>
        addMessageReturningId(
          sessionId,
          { role: "assistant", content: "stopped partial", timestamp: new Date().toISOString() },
          { source: "assistant", messageType: "chat_stopped", visibility: "user" },
          tx,
        ),
      { site: "assistant_message" },
    );
    expect(outcome.fenced).toBe(true);
    expect(outcome.state).toBe("released");
    expect(await messageCount(sessionId)).toBe(1);
  });
});
