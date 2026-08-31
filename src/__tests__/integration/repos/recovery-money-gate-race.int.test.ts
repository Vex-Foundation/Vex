/**
 * Integration: the recovery money gate is a BOUNDARY, not a snapshot - proven
 * with two real Postgres clients racing each other.
 *
 * THE DEFECT THIS PINS. The gate used to read the unresolved money state under
 * the session control lock, RELEASE the lock, and then claim the run in a
 * separate transaction. `claimRunLeaseAndFlipToRunning` takes row locks on
 * `mission_runs` and `runner_leases` but never the session control lock, so a
 * money writer blocked behind the gate's read would commit the instant that
 * read released - and Recover would resume the run over exactly the unproven
 * outcome the gate exists to refuse. The loss is a double spend.
 *
 * WHY THIS CANNOT BE A UNIT TEST. The existing retry tests mock the lock, and a
 * mocked lock excludes nothing: there is no second transaction, no lock queue
 * and no commit ordering to observe. The property under test is that two
 * concurrent transactions cannot interleave, which only real clients can show.
 *
 * BOTH ORDERINGS ARE ASSERTED, because "the gate blocked" is only half the
 * claim - a gate that blocked because it never ran would pass that half too:
 *
 *   A. the money writer commits FIRST -> the gate sees it and refuses, and the
 *      run is left untouched, its scheduled auto-retry still pending;
 *   B. the gate takes the lock FIRST -> the money writer is made to WAIT on the
 *      lock until the claim is durable, and the claim succeeds.
 *
 * Ordering B is the one that regressed: before the fix the writer did not wait,
 * because by the time it mattered the gate had already let go.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { execute, query } from "@vex-agent/db/client.js";
// The real key builder, never a hand-spelled namespace: a test that guessed the
// lock key would take a DIFFERENT lock and prove exclusion that does not exist.
import { sessionControlLockKey } from "@vex-agent/engine/runtime/lease-and-status.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/** The same advisory-lock statement every holder of this lock issues. */
const TAKE_SESSION_LOCK =
  "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

function containerUrl(): string {
  const raw = process.env.VEX_DB_URL;
  if (raw === undefined) {
    throw new Error("VEX_DB_URL is unset - the postgres global setup did not run");
  }
  return raw;
}

// The dispatcher module reaches the desktop compose credentials and the
// electron logger on the way in. Neither is the subject; the gate itself,
// the lock, the money reader and the claim are all real below.
vi.mock("../../../../vex-app/src/main/database/db-config.js", () => ({
  buildPoolConfig: async () => {
    const url = new URL(containerUrl());
    return {
      host: url.hostname,
      port: Number(url.port),
      database: url.pathname.replace(/^\//, ""),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  },
}));
vi.mock("../../../../vex-app/src/main/logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { gatedClaimUnderSessionLock } = await import(
  "../../../../vex-app/src/main/ipc/_shared/runtime-retry-dispatch.js"
);

interface Seeded {
  readonly sessionId: string;
  readonly runId: string;
}

async function seedPausedErrorRun(): Promise<Seeded> {
  const sessionId = await makeSession();
  const missionId = `mission-${sessionId}`;
  const runId = `run-${sessionId}`;
  await execute(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'money gate race')`,
    [missionId, sessionId],
  );
  await execute(
    `INSERT INTO mission_runs (id, mission_id, session_id, status, started_at)
     VALUES ($1, $2, $3, 'paused_error', NOW())`,
    [runId, missionId, sessionId],
  );
  return { sessionId, runId };
}

/** A pending auto-retry wake, so the cancellation's transactionality is visible. */
async function seedRetryWake(seeded: Seeded): Promise<void> {
  await execute(
    `INSERT INTO loop_wake_requests
       (session_id, mission_run_id, due_at, status, reason)
     VALUES ($1, $2, NOW() + interval '30 seconds', 'pending', 'error_retry')`,
    [seeded.sessionId, seeded.runId],
  );
}

/** The realistic unresolved money state: an approval the operator still owes. */
const INSERT_PENDING_APPROVAL = `
  INSERT INTO approval_queue (id, tool_call, reasoning, status, session_id)
  VALUES ($1, '{}'::jsonb, 'money gate race', 'pending', $2)`;

async function runStatus(runId: string): Promise<string> {
  const rows = await query<{ status: string }>(
    `SELECT status FROM mission_runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.status ?? "missing";
}

async function pendingWakeCount(sessionId: string): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM loop_wake_requests
      WHERE session_id = $1 AND status = 'pending'`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? "0");
}

/** A second, independent connection - the money writer's own client. */
async function openWriter(): Promise<Client> {
  const client = new Client({ connectionString: containerUrl() });
  await client.connect();
  return client;
}

function gateFor(seeded: Seeded) {
  return gatedClaimUnderSessionLock({
    sessionId: seeded.sessionId,
    runId: seeded.runId,
    status: "paused_error",
    ownerId: `race-owner-${randomUUID()}`,
  });
}

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the recovery money gate under a real concurrent money writer", () => {
  it("A. a money writer that commits FIRST is seen, and Recover is refused", async () => {
    const seeded = await seedPausedErrorRun();
    await seedRetryWake(seeded);

    const writer = await openWriter();
    try {
      await writer.query("BEGIN");
      await writer.query(TAKE_SESSION_LOCK, [
        sessionControlLockKey(seeded.sessionId),
      ]);
      await writer.query(INSERT_PENDING_APPROVAL, [
        randomUUID(),
        seeded.sessionId,
      ]);
      await writer.query("COMMIT");
    } finally {
      await writer.end();
    }

    const gated = await gateFor(seeded);

    expect(gated.kind).toBe("blocked_money_state");
    if (gated.kind !== "blocked_money_state") return;
    expect(gated.reasonKinds).toContain("approval_queue_pending");
    // Refused means UNTOUCHED. The run is still parked and its scheduled
    // auto-retry is still pending: a refused Recover that had already
    // cancelled the retry would leave the run with neither.
    expect(await runStatus(seeded.runId)).toBe("paused_error");
    expect(await pendingWakeCount(seeded.sessionId)).toBe(1);
  });

  /**
   * THE discriminating case, and the only one that fails against the pre-fix
   * code. It is worth explaining why the obvious version of this test is
   * worthless.
   *
   * The obvious version has the writer take the lock first and commit, then
   * runs the gate. That passes either way: a writer that commits BEFORE the
   * money read is seen by the old code too. The defect is not "a writer that
   * commits first is missed" - it is "a writer that commits between the READ
   * and the CLAIM is missed", and reaching that window means stalling the gate
   * strictly inside its decision.
   *
   * A third client does the stalling by holding the `mission_runs` row the
   * claim must lock. That splits the two implementations cleanly:
   *
   *   PRE-FIX: read money (clear), COMMIT, release the session lock, then block
   *     on the run row. The writer - queued on the session lock - wakes while
   *     the run is STILL `paused_error`, commits its unresolved approval, and
   *     the claim then resumes the run over it.
   *   FIXED: the session lock is held across the read AND the claim, so the
   *     writer cannot wake until the claim has committed. It observes the run
   *     already `running`.
   *
   * So the writer's OWN observation of the run status, taken the instant it
   * finally gets the lock, is the assertion. It is a fact about lock
   * ownership, not a timing coincidence.
   */
  it("B. a money writer cannot commit between the money read and the claim", async () => {
    const seeded = await seedPausedErrorRun();
    await seedRetryWake(seeded);

    const blocker = await openWriter();
    const writer = await openWriter();
    try {
      // 1. Stall the claim: hold the run row the claim must lock FOR UPDATE.
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM mission_runs WHERE id = $1 FOR UPDATE`,
        [seeded.runId],
      );

      // 2. The gate starts. It reads a CLEAR money state, then reaches the
      //    claim and blocks on the row the blocker holds.
      const gatePromise = gateFor(seeded);
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 3. A money writer arrives and does what every real money-path writer
      //    does: take the session control lock, then write. The status it sees
      //    the moment it holds the lock is the evidence.
      const writerObserved = (async () => {
        await writer.query("BEGIN");
        await writer.query(TAKE_SESSION_LOCK, [
          sessionControlLockKey(seeded.sessionId),
        ]);
        const seen = await writer.query<{ status: string }>(
          `SELECT status FROM mission_runs WHERE id = $1`,
          [seeded.runId],
        );
        await writer.query(INSERT_PENDING_APPROVAL, [
          randomUUID(),
          seeded.sessionId,
        ]);
        await writer.query("COMMIT");
        return seen.rows[0]?.status ?? "missing";
      })();

      // 4. Let the claim through.
      await new Promise((resolve) => setTimeout(resolve, 300));
      await blocker.query("COMMIT");

      const gated = await gatePromise;
      const observed = await writerObserved;

      expect(gated.kind).toBe("claimed");
      // The whole property. `paused_error` here means the writer held the
      // session control lock while the run was still parked - i.e. the gate
      // had released it after the read and the claim had not happened yet,
      // which is precisely the window in which an unresolved money row can be
      // committed under a Recover that already decided to proceed.
      expect(observed).toBe("running");
    } finally {
      await blocker.end();
      await writer.end();
    }
  });

  it("C. with the money state clear the gate claims, and the claim is durable", async () => {
    const seeded = await seedPausedErrorRun();
    await seedRetryWake(seeded);

    const gated = await gateFor(seeded);

    expect(gated.kind).toBe("claimed");
    if (gated.kind !== "claimed") return;
    expect(gated.claim.outcome).toBe("claimed");
    // All three effects committed together: status flipped, the superseded
    // auto-retry cancelled, the lease held.
    expect(await runStatus(seeded.runId)).toBe("running");
    expect(await pendingWakeCount(seeded.sessionId)).toBe(0);
    const leases = await query<{ owner_id: string }>(
      `SELECT owner_id FROM runner_leases WHERE session_id = $1`,
      [seeded.sessionId],
    );
    expect(leases).toHaveLength(1);
  });

  it("D. a money writer AFTER a successful claim does not undo it", async () => {
    const seeded = await seedPausedErrorRun();

    const gated = await gateFor(seeded);
    expect(gated.kind).toBe("claimed");

    // The writer was blocked behind the gate and commits once it is through.
    // The run is already running and owned; the late row is the next gate's
    // problem, not this claim's.
    const writer = await openWriter();
    try {
      await writer.query(INSERT_PENDING_APPROVAL, [
        randomUUID(),
        seeded.sessionId,
      ]);
    } finally {
      await writer.end();
    }

    expect(await runStatus(seeded.runId)).toBe("running");
    // And a SECOND Recover now refuses, which is the correct next answer.
    const second = await gateFor(seeded);
    expect(second.kind).toBe("blocked_money_state");
  });

  it("two concurrent gated claims produce exactly ONE winner", async () => {
    const seeded = await seedPausedErrorRun();

    const [first, second] = await Promise.all([
      gateFor(seeded),
      gateFor(seeded),
    ]);

    const claimed = [first, second].filter(
      (r) => r.kind === "claimed" && r.claim.outcome === "claimed",
    );
    expect(claimed).toHaveLength(1);
    expect(await runStatus(seeded.runId)).toBe("running");
  });
});
