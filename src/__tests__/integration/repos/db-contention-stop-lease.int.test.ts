/**
 * Kairos S-4 under contention, on a real (disposable, testcontainers) Postgres.
 *
 * The user's Stop and the runner's lease renewal run on the reserved CONTROL
 * pool with the same server-side bounds as the main pool. What is proven here
 * is that neither can hang, whatever else is holding the database:
 *
 *   1. main pool saturated (every main client checked out): Stop is queued and
 *      the lease renews, both promptly, through the control pool;
 *   2. a blocking row lock on the `runner_leases` row: Stop does not wait on it
 *      at all (it only reads the row); the renewal waits at most
 *      `statement_timeout`, fails OBSERVABLY (a logged heartbeat failure), does
 *      not mark the lease lost, and renews on the next tick once the lock goes;
 *   3. a stuck transaction holding the SESSION CONTROL LOCK: Stop fails with
 *      `query_canceled` within `statement_timeout` instead of hanging;
 *   4. DB-wide connection exhaustion (every server slot taken): Stop rejects
 *      within the connect bound with the server's "too many clients" error, the
 *      renewal failure is logged without marking the lease lost, and both
 *      succeed once slots free up.
 *
 * Tight bounds are set BEFORE the pool modules load so the proof runs in a few
 * seconds; the environment is restored afterwards.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";

const TIGHT_ENV = {
  AGENT_DB_STATEMENT_TIMEOUT_MS: "1000",
  AGENT_DB_CONNECTION_TIMEOUT_MS: "1000",
  AGENT_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: "10000",
  AGENT_DB_LONG_STATEMENT_TIMEOUT_MS: "5000",
} as const;

const saved: Record<string, string | undefined> = {};
for (const [key, value] of Object.entries(TIGHT_ENV)) {
  saved[key] = process.env[key];
  process.env[key] = value;
}

const client = await import("@vex-agent/db/client.js");
const control = await import("@vex-agent/db/control-pool.js");
const leases = await import("@vex-agent/db/repos/runner-leases.js");
const { createLeaseHandle } = await import("@vex-agent/engine/runtime/lease-handle.js");
const { enqueueSessionStopRequest } = await import(
  "@vex-agent/engine/runtime/lease-and-status/operator-stop-boundary.js"
);
const { acquireSessionControlLock } = await import(
  "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js"
);
const { makeSession } = await import("../setup/fixtures.js");
const { default: logger } = await import("@utils/logger.js");

const TTL_MS = 60_000;
const HEARTBEAT_FAILED = "runner_lease.handle.heartbeat_failed";

function sqlState(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    return typeof err.code === "string" ? err.code : null;
  }
  return null;
}

/** A heartbeat timer the test fires by hand, so every renewal is deliberate. */
function manualTimer() {
  let callback: (() => void) | null = null;
  return {
    timer: {
      setInterval: (cb: () => void, _ms: number): ReturnType<typeof setInterval> => {
        callback = cb;
        return setInterval(() => undefined, 2 ** 30);
      },
      clearInterval: (handle: ReturnType<typeof setInterval>): void => {
        clearInterval(handle);
        callback = null;
      },
    },
    fire: (): void => {
      if (callback === null) throw new Error("heartbeat not armed");
      callback();
    },
  };
}

/** Read through the CONTROL pool so it works while the main pool is saturated. */
async function leaseExpiry(sessionId: string): Promise<number> {
  return control.withControlClient(async (c) => {
    const r = await c.query<{ expires_at: Date }>(
      "SELECT expires_at FROM runner_leases WHERE session_id = $1",
      [sessionId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error("lease row missing");
    return row.expires_at.getTime();
  });
}

async function claimWithHandle(sessionId: string) {
  const lease = await leases.acquireLease({
    sessionId,
    ownerId: "runner-contention",
    processKind: "test",
    ttlMs: TTL_MS,
  });
  if (lease === null) throw new Error("expected a lease");
  const clock = manualTimer();
  const handle = createLeaseHandle({ lease, ownerId: "runner-contention", ttlMs: TTL_MS, timer: clock.timer });
  return { handle, clock };
}

function rawClient(): pg.Client {
  const url = process.env.VEX_DB_URL;
  if (url === undefined) throw new Error("VEX_DB_URL is not set by the global setup");
  return new pg.Client({ connectionString: url, application_name: "vex-contention-holder" });
}

/** Wait until the renewal after `before` has moved `expires_at` forward. */
async function expectRenewedAfter(sessionId: string, before: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await leaseExpiry(sessionId)).toBeGreaterThan(before);
  }, { timeout: 5_000, interval: 50 });
}

function heartbeatFailures(spy: { mock: { calls: unknown[][] } }, sessionId: string): string[] {
  const errors: string[] = [];
  for (const call of spy.mock.calls) {
    const meta: unknown = call[1];
    if (call[0] !== HEARTBEAT_FAILED) continue;
    if (typeof meta !== "object" || meta === null) continue;
    if (!("sessionId" in meta) || meta.sessionId !== sessionId) continue;
    errors.push("error" in meta && typeof meta.error === "string" ? meta.error : "");
  }
  return errors;
}

describe("S-4 Stop and lease renewal under DB contention (disposable Postgres)", () => {
  beforeAll(async () => {
    const db = await client.queryOne<{ name: string }>("SELECT current_database() AS name");
    // Disposable testcontainers database only, never the owner's app DB.
    expect(db?.name).toBe("vex_test");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await client.closePool();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("main pool saturated: Stop is queued and the lease renews through the control pool", async () => {
    const sessionId = await makeSession();
    const { handle, clock } = await claimWithHandle(sessionId);
    const pool = client.getPool();
    const held: pg.PoolClient[] = [];
    try {
      for (let i = 0; i < 10; i += 1) held.push(await pool.connect());
      await expect(pool.connect()).rejects.toThrow(/timeout/i);

      const startedAt = Date.now();
      const stop = await enqueueSessionStopRequest({ sessionId });
      expect(stop.outcome).toBe("queued");
      expect(Date.now() - startedAt).toBeLessThan(1_000);

      const before = await leaseExpiry(sessionId);
      await new Promise((resolve) => setTimeout(resolve, 20));
      clock.fire();
      await expectRenewedAfter(sessionId, before);
      expect(handle.lostReason()).toBeNull();
    } finally {
      for (const c of held) c.release();
      await handle.release();
    }
  });

  it("a row lock on runner_leases: Stop does not wait on it; the renewal is bounded, logged, and recovers", async () => {
    const sessionId = await makeSession();
    const { handle, clock } = await claimWithHandle(sessionId);
    const warn = vi.spyOn(logger, "warn");
    const holder = rawClient();
    await holder.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM runner_leases WHERE session_id = $1 FOR UPDATE", [sessionId]);
      const beforeLock = await leaseExpiry(sessionId);

      // Stop only READS the lease row, so a row lock cannot delay it.
      const stopStartedAt = Date.now();
      const stop = await enqueueSessionStopRequest({ sessionId });
      expect(stop.outcome).toBe("queued");
      expect(Date.now() - stopStartedAt).toBeLessThan(900);

      // The renewal UPDATE waits on the lock, but only for statement_timeout.
      const tickAt = Date.now();
      clock.fire();
      await vi.waitFor(() => {
        expect(heartbeatFailures(warn, sessionId)).toHaveLength(1);
      }, { timeout: 5_000, interval: 25 });
      const waited = Date.now() - tickAt;
      expect(waited).toBeGreaterThanOrEqual(900);
      expect(waited).toBeLessThan(3_000);
      expect(heartbeatFailures(warn, sessionId)[0]).toMatch(/statement timeout/i);
      // A failed renewal is not a lost lease: the runner keeps working.
      expect(handle.lostReason()).toBeNull();
      expect(handle.lostSignal.aborted).toBe(false);
      expect(await leaseExpiry(sessionId)).toBe(beforeLock);

      await holder.query("ROLLBACK");
      clock.fire();
      await expectRenewedAfter(sessionId, beforeLock);
      expect(heartbeatFailures(warn, sessionId)).toHaveLength(1);
      expect(handle.lostReason()).toBeNull();
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await handle.release();
    }
  });

  it("a stuck transaction on the session control lock: Stop fails within statement_timeout, never hangs", async () => {
    const sessionId = await makeSession();
    const stuck = await client.getPool().connect();
    try {
      await stuck.query("BEGIN");
      await acquireSessionControlLock(stuck, sessionId);

      const startedAt = Date.now();
      const err = await enqueueSessionStopRequest({ sessionId }).then(
        () => null,
        (e: unknown) => e,
      );
      const waited = Date.now() - startedAt;
      expect(sqlState(err)).toBe("57014"); // query_canceled
      expect(waited).toBeGreaterThanOrEqual(900);
      expect(waited).toBeLessThan(3_000);

      await stuck.query("ROLLBACK");
      // With the lock free the same Stop goes through (no lease: applied).
      const retried = await enqueueSessionStopRequest({ sessionId });
      expect(retried.outcome).toBe("applied");
    } finally {
      await stuck.query("ROLLBACK").catch(() => undefined);
      stuck.release();
    }
  });

  it("DB-wide connection exhaustion: Stop and renewal fail within the connect bound, observably, then recover", async () => {
    const sessionId = await makeSession();
    const { handle, clock } = await claimWithHandle(sessionId);
    const warn = vi.spyOn(logger, "warn");
    // No idle control connection may survive into the exhausted window: every
    // control-pool call below has to ask the server for a new slot.
    await control.closeControlPool();
    const hogs: pg.Client[] = [];
    try {
      let refusal: unknown = null;
      for (let i = 0; i < 500 && refusal === null; i += 1) {
        const hog = rawClient();
        try {
          await hog.connect();
          hogs.push(hog);
        } catch (err) {
          refusal = err;
        }
      }
      expect(sqlState(refusal)).toBe("53300"); // too_many_connections

      const startedAt = Date.now();
      const err = await enqueueSessionStopRequest({ sessionId }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(sqlState(err)).toBe("53300");

      clock.fire();
      await vi.waitFor(() => {
        expect(heartbeatFailures(warn, sessionId)).toHaveLength(1);
      }, { timeout: 5_000, interval: 25 });
      expect(heartbeatFailures(warn, sessionId)[0]).toMatch(/too many clients|connection slots/i);
      expect(handle.lostReason()).toBeNull();

      await Promise.all(hogs.splice(0).map((hog) => hog.end()));

      const expiryBefore = await leaseExpiry(sessionId);
      const stop = await enqueueSessionStopRequest({ sessionId });
      expect(stop.outcome).toBe("queued");
      clock.fire();
      await expectRenewedAfter(sessionId, expiryBefore);
      expect(handle.lostReason()).toBeNull();
    } finally {
      await Promise.all(hogs.map((hog) => hog.end().catch(() => undefined)));
      await handle.release();
    }
  });
});
