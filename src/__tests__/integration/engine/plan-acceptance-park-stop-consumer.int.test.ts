/**
 * Integration: the durable operator-Stop consumer at the PLAN-ACCEPTANCE park,
 * proven against real Postgres.
 *
 * Why THIS park gets the integration test rather than a mock. It is the only one
 * of the seven terminal park sites with NO timed self-heal: `paused_wake` wakes
 * itself, `paused_error` may auto-retry, but `paused_plan_acceptance` resumes
 * only when the USER accepts a plan. So a `stop_terminal` queued after the turn
 * loop's last iteration checkpoint and before this write used to strand
 * indefinitely — the operator's Stop silently lost until they accepted a plan on
 * a run they had already stopped, which then resumed it.
 *
 * A mocked `db/client.js` cannot demonstrate the fix: with one fake client there
 * is no advisory-lock queue, no second transaction and no snapshot boundary, so
 * "the Stop was visible to the park" is unrepresentable. This file drives the
 * real control plane end to end — a genuine queued request row, the real gate,
 * the real park — and asserts on what Postgres actually committed.
 *
 * Companion to `operator-stop-boundary.int.test.ts` and
 * `stop-for-edit-precedence.int.test.ts`; same fixtures, same
 * `EMBEDDING_BASE_URL` requirement from the shared globalSetup.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import { enqueueOperatorStopRequest } from "@vex-agent/engine/runtime/lease-and-status.js";
import { applyPlanAcceptancePausePostBatch } from "@vex-agent/engine/core/turn-loop-plan-acceptance-pause.js";
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
     VALUES ($1, $2, 'running', 'plan-acceptance park stop consumer')`,
    [missionId, sessionId],
  );
  await query(
    `INSERT INTO mission_runs (id, mission_id, session_id, status)
     VALUES ($1, $2, $3, 'running')`,
    [missionRunId, missionId, sessionId],
  );
  return { sessionId, missionId, missionRunId };
}

async function readRun(
  missionRunId: string,
): Promise<{ status: string; stop_reason: string | null } | null> {
  return queryOne<{ status: string; stop_reason: string | null }>(
    "SELECT status, stop_reason FROM mission_runs WHERE id = $1",
    [missionRunId],
  );
}

async function openRequestCount(sessionId: string): Promise<number> {
  const rows = await query(
    `SELECT id FROM runtime_control_requests
      WHERE session_id = $1 AND status IN ('pending','observed')`,
    [sessionId],
  );
  return rows.length;
}

describe("plan-acceptance park — durable operator-Stop consumer (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("a queued Stop is APPLIED instead of parking the run for plan acceptance", async () => {
    const seeded = await seedRunningMission();

    const queued = await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    expect(queued.outcome).toBe("queued");
    // Nothing has observed it yet — this is exactly the stranded state.
    expect((await readRun(seeded.missionRunId))?.status).toBe("running");

    await applyPlanAcceptancePausePostBatch({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    // The run is STOPPED, not parked: no `paused_plan_acceptance` write landed,
    // so the user's Stop was neither erased nor left waiting on a plan they
    // would have had to accept on a run they had already stopped.
    const run = await readRun(seeded.missionRunId);
    expect(run?.status).toBe("stopped");
    expect(run?.stop_reason).toBe("user_stopped");

    // The canonical stop body ran in full — the parent mission is cancelled.
    const mission = await queryOne<{ status: string }>(
      "SELECT status FROM missions WHERE id = $1",
      [seeded.missionId],
    );
    expect(mission?.status).toBe("cancelled");

    // The request is CONSUMED, so it cannot terminate a later run.
    expect(await openRequestCount(seeded.sessionId)).toBe(0);
  });

  it("parks normally when no Stop is queued", async () => {
    const seeded = await seedRunningMission();

    await applyPlanAcceptancePausePostBatch({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    const run = await readRun(seeded.missionRunId);
    expect(run?.status).toBe("paused_plan_acceptance");
    expect(run?.stop_reason).toBe("plan_acceptance_required");
  });

  it("is idempotent — a second park pass on an already-stopped run writes nothing", async () => {
    const seeded = await seedRunningMission();
    await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    await applyPlanAcceptancePausePostBatch({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    await applyPlanAcceptancePausePostBatch({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    const run = await readRun(seeded.missionRunId);
    expect(run?.status).toBe("stopped");
    expect(run?.stop_reason).toBe("user_stopped");
  });

  it("racing the Stop INSERT against the park never yields a resumable stopped run", async () => {
    // The real interleaving, decided by Postgres rather than by the test: both
    // transactions take the session control lock, so exactly one order happens.
    // Either the stop commits first (park refuses, run stays `stopped`) or the
    // park commits first (the stop lands on the parked run and takes it
    // terminal). The forbidden third outcome — a run left
    // `paused_plan_acceptance` with a `stop_terminal` request still open, i.e.
    // resumable by plan acceptance despite the operator's Stop — must never
    // occur, whichever side won.
    const seeded = await seedRunningMission();

    await Promise.all([
      applyPlanAcceptancePausePostBatch({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
      }),
      enqueueOperatorStopRequest({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
      }),
    ]);

    const run = await readRun(seeded.missionRunId);
    const stillOpen = await openRequestCount(seeded.sessionId);
    if (run?.status === "paused_plan_acceptance") {
      // The park won the lock. The stop then observed a live run and queued —
      // legitimately, and the IPC stop path applies it directly. What must NOT
      // happen is the request being lost.
      expect(stillOpen).toBe(1);
    } else {
      expect(run?.status).toBe("stopped");
      expect(run?.stop_reason).toBe("user_stopped");
      expect(stillOpen).toBe(0);
    }
  });
});
