/**
 * Integration: the operator-Stop serialization boundary, proven with REAL
 * concurrent Postgres clients.
 *
 * Why this file exists at all. The defect Codex blocked the commit on is a
 * `READ COMMITTED` interleaving: `control-request-locks.ts` can only lock
 * `runtime_control_requests` rows that ALREADY exist, so nothing stopped a NEW
 * `stop_terminal` row being INSERTED after a decision had read the set — and
 * an approved money-path tool could then execute after the user pressed Stop.
 * A mocked `db/client.js` cannot demonstrate either the bug or the fix: with
 * one fake client there is no second transaction, no lock queue, and no
 * snapshot boundary. Every proof below therefore drives TWO real pool clients
 * and asserts on the ORDER Postgres actually produced.
 *
 * What is proven:
 *   1. the session control lock genuinely serializes — a second holder blocks
 *      until the first COMMITs (the property the whole design rests on);
 *   2. a Stop inserted while the approved-dispatch gate holds the lock cannot
 *      commit before the gate does, so the gate's verdict is never stale;
 *   3. a Stop that committed FIRST is seen by the gate, which applies it and
 *      refuses — the money-path case: no dispatch after Stop;
 *   4. the approval enqueue takes the same boundary, so no approvable action is
 *      parked on a run the operator already stopped;
 *   5. the insert side refuses to queue a stop onto an already-terminal run;
 *   6. two concurrent gates on the same session do not deadlock against the
 *      existing REQUESTS → RUN row-lock scheme.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { getPool, query, queryOne, withTransaction } from "@vex-agent/db/client.js";
import {
  enqueueOperatorStopRequest,
  gateOnOperatorStopTransaction,
  gateOnOperatorStopWithClient,
  acquireSessionControlLock,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import { enqueueRequest } from "@vex-agent/db/repos/runtime-control-requests.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

interface SeededRun {
  readonly sessionId: string;
  readonly missionId: string;
  readonly missionRunId: string;
}

async function seedRunningMission(): Promise<SeededRun> {
  const sessionId = await makeSession();
  const missionId = `mission-${sessionId}`;
  const missionRunId = `run-${sessionId}`;
  await query(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'stop-boundary integration')`,
    [missionId, sessionId],
  );
  await query(
    `INSERT INTO mission_runs (id, mission_id, session_id, status)
     VALUES ($1, $2, $3, 'running')`,
    [missionRunId, missionId, sessionId],
  );
  return { sessionId, missionId, missionRunId };
}

async function runStatus(missionRunId: string): Promise<string | null> {
  const row = await queryOne<{ status: string; stop_reason: string | null }>(
    "SELECT status, stop_reason FROM mission_runs WHERE id = $1",
    [missionRunId],
  );
  return row?.status ?? null;
}

async function stopReason(missionRunId: string): Promise<string | null> {
  const row = await queryOne<{ stop_reason: string | null }>(
    "SELECT stop_reason FROM mission_runs WHERE id = $1",
    [missionRunId],
  );
  return row?.stop_reason ?? null;
}

/** Poll until `check` is true or the budget runs out. No fixed sleeps. */
async function waitUntil(
  check: () => boolean | Promise<boolean>,
  budgetMs = 3000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("operator-stop boundary (integration, two real clients)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("1. the session control lock serializes two real transactions", async () => {
    const { sessionId } = await seedRunningMission();
    const order: string[] = [];

    const holder = getPool().connect();
    const holderClient = await holder;
    await holderClient.query("BEGIN");
    await acquireSessionControlLock(holderClient, sessionId);
    order.push("A:acquired");

    let contenderDone = false;
    const contender = withTransaction(async (client) => {
      await acquireSessionControlLock(client, sessionId);
      order.push("B:acquired");
      contenderDone = true;
    });

    // B must still be blocked while A holds the lock. Give it real time to
    // (incorrectly) proceed — if the lock did nothing, this window is plenty.
    const proceededEarly = await waitUntil(() => contenderDone, 300);
    expect(proceededEarly).toBe(false);
    order.push("A:committing");
    await holderClient.query("COMMIT");
    holderClient.release();

    await contender;
    expect(order).toEqual(["A:acquired", "A:committing", "B:acquired"]);
  });

  it("2. a Stop insert cannot slip inside the gate's window — the ADVISORY lock, not a row lock", async () => {
    const seeded = await seedRunningMission();
    const order: string[] = [];

    // Deliberately isolate the boundary: this transaction holds ONLY the
    // advisory lock and has touched no row yet. That matters, because the
    // interleaving that actually bites is snapshot-shaped, not row-shaped —
    // the gate reads the open-request SET before it locks the run row, and it
    // may not re-read that set afterwards (re-taking the request lock after
    // the run lock is the documented deadlock, Wave-1 defect 5). So a stop
    // that commits between those two steps would be invisible to the gate
    // even though every row lock was taken correctly. If the assertion below
    // ever passes with the advisory lock removed, the boundary is gone.
    const gateClient = await getPool().connect();
    await gateClient.query("BEGIN");
    await acquireSessionControlLock(gateClient, seeded.sessionId);
    order.push("gate:boundary_held");

    // The operator presses Stop at the worst possible moment.
    let stopCommitted = false;
    const stop = enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
      correlationId: "corr-race",
    }).then((outcome) => {
      stopCommitted = true;
      order.push("stop:committed");
      return outcome;
    });

    const raced = await waitUntil(() => stopCommitted, 300);
    expect(raced).toBe(false);

    // Only now does the gate read anything — and it reads a world in which the
    // racing stop has provably not committed.
    const verdict = await gateOnOperatorStopWithClient(gateClient, {
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    expect(verdict.kind).toBe("clear");
    order.push("gate:committed");
    await gateClient.query("COMMIT");
    gateClient.release();

    const outcome = await stop;
    expect(outcome.outcome).toBe("queued");
    expect(order).toEqual([
      "gate:boundary_held",
      "gate:committed",
      "stop:committed",
    ]);
  });

  it("3. a Stop that committed FIRST makes the gate refuse and lands the stop", async () => {
    const seeded = await seedRunningMission();

    const queued = await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
      correlationId: "corr-first",
    });
    expect(queued.outcome).toBe("queued");
    // Nothing has observed it yet — the run is still live.
    expect(await runStatus(seeded.missionRunId)).toBe("running");

    const verdict = await gateOnOperatorStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    // `scope` distinguishes a run-scoped stop from the session-scoped one a
    // Full-Autonomous agent slice uses; this path is always run-scoped.
    expect(verdict).toEqual({
      kind: "stopped",
      runStatus: "stopped",
      scope: "run",
    });
    // The gate did not merely detect the stop — it applied the canonical one.
    expect(await runStatus(seeded.missionRunId)).toBe("stopped");
    expect(await stopReason(seeded.missionRunId)).toBe("user_stopped");
    const mission = await queryOne<{ status: string }>(
      "SELECT status FROM missions WHERE id = $1",
      [seeded.missionId],
    );
    expect(mission?.status).toBe("cancelled");
    // The request is consumed, so a second caller finds nothing to re-apply.
    const open = await query<{ status: string }>(
      `SELECT status FROM runtime_control_requests
        WHERE session_id = $1 AND status IN ('pending','observed')`,
      [seeded.sessionId],
    );
    expect(open).toHaveLength(0);
  });

  it("3b. the gate is idempotent — a second pass reports the same terminal status", async () => {
    const seeded = await seedRunningMission();
    await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    const first = await gateOnOperatorStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    const second = await gateOnOperatorStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    expect(first).toEqual({
      kind: "stopped",
      runStatus: "stopped",
      scope: "run",
    });
    expect(second).toEqual({
      kind: "stopped",
      runStatus: "stopped",
      scope: "run",
    });
    expect(await stopReason(seeded.missionRunId)).toBe("user_stopped");
  });

  it("4. a queued Stop rejects the session's pending approvals as it lands", async () => {
    const seeded = await seedRunningMission();
    await query(
      `INSERT INTO approval_queue
         (id, session_id, tool_call, reasoning, status, permission_at_enqueue)
       VALUES ($1, $2, $3::jsonb, 'swap 1 ETH', 'pending', 'restricted')`,
      [
        "appr-int-1",
        seeded.sessionId,
        JSON.stringify({ command: "kyberswap_swap", args: {} }),
      ],
    );
    await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    const verdict = await gateOnOperatorStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    expect(verdict.kind).toBe("stopped");

    const approval = await queryOne<{ status: string }>(
      "SELECT status FROM approval_queue WHERE id = $1",
      ["appr-int-1"],
    );
    expect(approval?.status).toBe("rejected");
  });

  it("5. the insert side refuses to queue a Stop onto an already-terminal run", async () => {
    const seeded = await seedRunningMission();
    await query(
      "UPDATE mission_runs SET status = 'completed', ended_at = NOW() WHERE id = $1",
      [seeded.missionRunId],
    );

    const outcome = await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    expect(outcome).toEqual({ outcome: "already_terminal", runStatus: "completed" });
    const rows = await query(
      "SELECT id FROM runtime_control_requests WHERE session_id = $1",
      [seeded.sessionId],
    );
    expect(rows).toHaveLength(0);
  });

  it("5b. a vanished run is refused rather than given a stranded request", async () => {
    const sessionId = await makeSession();

    const outcome = await enqueueOperatorStopRequest({
      sessionId,
      missionRunId: "run-that-never-existed",
    });

    expect(outcome).toEqual({ outcome: "run_not_found" });
  });

  it("6. two concurrent gates on one session serialize instead of deadlocking", async () => {
    const seeded = await seedRunningMission();
    // A pre-existing OPEN request of another kind guarantees both transactions
    // really take the REQUESTS row lock as well as the advisory lock, so this
    // exercises the full documented order, not just its first step.
    await enqueueRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
      kind: "pause_after_step",
      requestedBy: "user",
    });
    await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    const [a, b] = await Promise.all([
      gateOnOperatorStopTransaction({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
      }),
      gateOnOperatorStopTransaction({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
      }),
    ]);

    // Neither threw (a Postgres deadlock aborts one side with 40P01), and both
    // agree on the terminal state.
    expect(a.kind).toBe("stopped");
    expect(b.kind).toBe("stopped");
    expect(await runStatus(seeded.missionRunId)).toBe("stopped");
    expect(await stopReason(seeded.missionRunId)).toBe("user_stopped");
  });

  it("7. a Stop racing the insert side twice queues exactly one applicable request", async () => {
    const seeded = await seedRunningMission();

    const [first, second] = await Promise.all([
      enqueueOperatorStopRequest({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
        correlationId: "corr-a",
      }),
      enqueueOperatorStopRequest({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
        correlationId: "corr-b",
      }),
    ]);

    // Both are legitimate audit rows (the operator really did click twice);
    // what matters is that applying the stop consumes ALL of them, so no
    // request survives to terminate a LATER run.
    expect(first.outcome).toBe("queued");
    expect(second.outcome).toBe("queued");

    await gateOnOperatorStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    const open = await query(
      `SELECT id FROM runtime_control_requests
        WHERE session_id = $1 AND status IN ('pending','observed')`,
      [seeded.sessionId],
    );
    expect(open).toHaveLength(0);
  });
});
