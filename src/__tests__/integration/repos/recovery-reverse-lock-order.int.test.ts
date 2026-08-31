/**
 * Integration: the recovery gate takes its row locks in the SAME order as every
 * other claimant, proven against real Postgres with a real lock cycle staged.
 *
 * THE DEFECT THIS PINS. Making the money gate atomic put the auto-retry wake
 * cancellation inside the transaction - and, at first, BEFORE the claim. That
 * inverted the system's lock order. `claimRunLeaseAndFlipToRunningWith` locks
 * `mission_runs`, then `runner_leases`, then pending `loop_wake_requests`;
 * cancelling first took the wake rows before the run row. A lock-order
 * inversion is only a latent bug until two parties actually interleave, and
 * this one had a reachable interleaving:
 *
 *   1. `runRetryDispatch` reads the run status OUTSIDE the transaction and
 *      sees `paused_error`;
 *   2. the run advances to `paused_wake` before the gate's transaction opens
 *      (an auto-retry was scheduled, a wake was enqueued);
 *   3. a wake or Continue claimant locks the `mission_runs` row and heads for
 *      the wake rows;
 *   4. the stale Recover locks the pending wake row - its captured status
 *      still says `paused_error`, so it believes it should - then waits on the
 *      run row the claimant holds;
 *   5. the claimant waits on the wake row Recover holds.
 *
 * A cycle. Postgres detects it and aborts one side with SQLSTATE 40P01, which
 * turns "you lost a race" into "a control action failed". The correct outcome
 * for a stale Recover is a clean `status_mismatch`.
 *
 * WHY THE EXISTING RACE SUITE CANNOT SEE THIS. Every case in
 * `recovery-money-gate-race.int.test.ts` keeps the run at `paused_error` for
 * the whole test, so step 2 never happens and the two parties never contend
 * for the same pair of rows. The status CHANGE is the entire precondition, so
 * it has to be staged explicitly.
 *
 * WHAT IS ASSERTED. Not "no deadlock happened" - that would pass by luck on a
 * fast machine. The claimant is made to HOLD the run row across the whole
 * attempt, so under the reverse order the cycle is forced rather than raced.
 * Under the correct order there is no cycle to force: Recover blocks on the
 * run row like any other waiter, and once released reads `paused_wake`, fails
 * its `fromStatuses` check and returns `status_mismatch` having touched
 * nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

import { execute, query } from "@vex-agent/db/client.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

function containerUrl(): string {
  const raw = process.env.VEX_DB_URL;
  if (raw === undefined) {
    throw new Error("VEX_DB_URL is unset - the postgres global setup did not run");
  }
  return raw;
}

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

async function seedRun(status: string): Promise<Seeded> {
  const sessionId = await makeSession();
  const missionId = `mission-${sessionId}`;
  const runId = `run-${sessionId}`;
  await execute(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'reverse lock order')`,
    [missionId, sessionId],
  );
  await execute(
    `INSERT INTO mission_runs (id, mission_id, session_id, status, started_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [runId, missionId, sessionId, status],
  );
  return { sessionId, runId };
}

/** The scheduled auto-retry both parties would contend for. */
async function seedPendingWake(seeded: Seeded): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO loop_wake_requests
       (session_id, mission_run_id, due_at, status, reason)
     VALUES ($1, $2, NOW() + interval '30 seconds', 'pending', 'error_retry')
     RETURNING id`,
    [seeded.sessionId, seeded.runId],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("wake insert returned no id");
  return id;
}

async function readWake(
  id: string,
): Promise<{ status: string; cancelled_reason: string | null }> {
  const rows = await query<{ status: string; cancelled_reason: string | null }>(
    `SELECT status, cancelled_reason FROM loop_wake_requests WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (row === undefined) throw new Error("wake row vanished");
  return row;
}

async function runStatus(runId: string): Promise<string> {
  const rows = await query<{ status: string }>(
    `SELECT status FROM mission_runs WHERE id = $1`,
    [runId],
  );
  return rows[0]?.status ?? "missing";
}

async function openClient(): Promise<Client> {
  const client = new Client({ connectionString: containerUrl() });
  await client.connect();
  return client;
}

beforeEach(async () => {
  await resetDb();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the recovery gate's row-lock order", () => {
  /**
   * The staged inversion, end to end.
   *
   * `status: "paused_error"` passed to the gate is deliberately STALE - it is
   * what the dispatcher read outside the transaction. The row underneath has
   * already moved to `paused_wake`, which is precisely the situation in which
   * the old ordering cancelled a wake it had no business touching and then
   * queued behind a claimant that was coming the other way.
   */
  it("a STALE Recover loses cleanly instead of deadlocking with a wake claimant", async () => {
    const seeded = await seedRun("paused_error");
    const wakeId = await seedPendingWake(seeded);

    // The run advances after the dispatcher's outside read: an auto-retry was
    // scheduled and the run parked on it.
    await execute(`UPDATE mission_runs SET status = 'paused_wake' WHERE id = $1`, [
      seeded.runId,
    ]);

    const claimant = await openClient();
    try {
      // The competing claimant takes the run row FIRST, the correct order, and
      // holds it. Under the reverse order this is one half of the cycle; under
      // the correct order it is just a lock Recover has to wait for.
      await claimant.query("BEGIN");
      await claimant.query(
        `SELECT id FROM mission_runs WHERE id = $1 FOR UPDATE`,
        [seeded.runId],
      );

      // Recover runs with its stale status. Under the OLD order it grabs the
      // pending wake row here and then blocks on the run row, completing the
      // cycle the moment the claimant reaches for the wake.
      const gatePromise = gatedClaimUnderSessionLock({
        sessionId: seeded.sessionId,
        runId: seeded.runId,
        status: "paused_error",
        ownerId: `reverse-order-${randomUUID()}`,
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // The claimant now reaches for the wake rows, exactly as
      // `claimRunLeaseAndFlipToRunningWith` does for a `paused_wake` run. With
      // the wake row held by Recover this statement is the closing edge of the
      // cycle; with the correct order it returns immediately.
      await claimant.query(
        `UPDATE loop_wake_requests
            SET status = 'cancelled',
                cancelled_at = NOW(),
                cancelled_reason = 'consumed_by_resume'
          WHERE session_id = $1 AND status = 'pending'`,
        [seeded.sessionId],
      );
      await claimant.query("COMMIT");

      const gated = await gatePromise;

      // The stale Recover revalidated under the run-row lock, saw a status it
      // was not claiming from, and gave up. No deadlock, no exception.
      expect(gated.kind).toBe("claimed");
      if (gated.kind !== "claimed") return;
      expect(gated.claim.outcome).toBe("status_mismatch");
    } finally {
      await claimant.end();
    }

    // The run is whatever the CLAIMANT left it, untouched by the loser.
    expect(await runStatus(seeded.runId)).toBe("paused_wake");
    // And the wake carries the claimant's reason, never Recover's: the stale
    // path must not have written to this row at all.
    const wake = await readWake(wakeId);
    expect(wake.cancelled_reason).toBe("consumed_by_resume");
    expect(wake.cancelled_reason).not.toBe("superseded_by_manual_recover");
  });

  /**
   * The same staleness with no competitor at all. Isolates the ordering rule
   * from the contention: a claim that does not win must leave every wake row
   * exactly as it found it, because the cancellation is now conditional on
   * what the claim OBSERVED under the row lock rather than on the status read
   * outside the transaction.
   */
  it("a stale Recover touches no wake row when it loses the status check", async () => {
    const seeded = await seedRun("paused_wake");
    const wakeId = await seedPendingWake(seeded);

    const gated = await gatedClaimUnderSessionLock({
      sessionId: seeded.sessionId,
      runId: seeded.runId,
      status: "paused_error",
      ownerId: `stale-${randomUUID()}`,
    });

    expect(gated.kind).toBe("claimed");
    if (gated.kind !== "claimed") return;
    expect(gated.claim.outcome).toBe("status_mismatch");
    // Still pending: the loser cancelled nothing.
    expect((await readWake(wakeId)).status).toBe("pending");
    expect(await runStatus(seeded.runId)).toBe("paused_wake");
  });

  /**
   * The winning path still supersedes the auto-retry - the cancellation was
   * reordered, not dropped. `previousStatus` is the claim's own observation,
   * so this is the only shape in which Recover writes to a wake row.
   */
  it("a WINNING Recover still cancels the scheduled auto-retry", async () => {
    const seeded = await seedRun("paused_error");
    const wakeId = await seedPendingWake(seeded);

    const gated = await gatedClaimUnderSessionLock({
      sessionId: seeded.sessionId,
      runId: seeded.runId,
      status: "paused_error",
      ownerId: `winner-${randomUUID()}`,
    });

    expect(gated.kind).toBe("claimed");
    if (gated.kind !== "claimed") return;
    expect(gated.claim.outcome).toBe("claimed");
    const wake = await readWake(wakeId);
    expect(wake.status).toBe("cancelled");
    expect(wake.cancelled_reason).toBe("superseded_by_manual_recover");
    expect(await runStatus(seeded.runId)).toBe("running");
  });

  /**
   * The dead-lease reclaim path claims from `running`, so `previousStatus` is
   * `running` and no auto-retry supersession applies - a `running` row never
   * has an error-retry wake pending. Pinned so the condition is not loosened
   * back to "whatever the dispatcher read".
   */
  it("the dead-lease reclaim path cancels nothing", async () => {
    const seeded = await seedRun("running");
    const wakeId = await seedPendingWake(seeded);

    const gated = await gatedClaimUnderSessionLock({
      sessionId: seeded.sessionId,
      runId: seeded.runId,
      status: "running",
      ownerId: `reclaim-${randomUUID()}`,
    });

    expect(gated.kind).toBe("claimed");
    if (gated.kind !== "claimed") return;
    expect(gated.claim.outcome).toBe("claimed");
    expect((await readWake(wakeId)).status).toBe("pending");
  });
});
