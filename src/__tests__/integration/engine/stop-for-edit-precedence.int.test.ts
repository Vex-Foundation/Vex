/**
 * Integration: a committed user Stop is FINAL — "stop for edit" must not undo it.
 *
 * OWNER DECISION being pinned: if an ordinary operator Stop has committed
 * (run `stopped`/`user_stopped`, parent mission `cancelled`), a concurrent
 * stop-for-edit must NOT rewrite the run row and must NOT demote the mission
 * back to `draft`.
 *
 * Why this file needs REAL Postgres. Both writers land the identical
 * `stopped`/`user_stopped` status pair, so no assertion on the run status can
 * distinguish them — the only observable difference is the PARENT MISSION row
 * (`cancelled` vs `draft`) and the outcome discriminator the loser gets back.
 * And "the loser" only exists if two transactions genuinely interleave: with a
 * mocked `db/client.js` there is one fake client, no lock queue and no
 * snapshot boundary, so the bug (an unlocked read followed by an unconditional
 * write) is unrepresentable. Every proof below therefore drives real pool
 * clients and asserts on the order Postgres actually produced.
 *
 * Companion to `operator-stop-boundary.int.test.ts`; same fixtures, same
 * `EMBEDDING_BASE_URL` requirement from the shared globalSetup.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { getPool, query, queryOne, withTransaction } from "@vex-agent/db/client.js";
import {
  acquireSessionControlLock,
  applyStopForEditTransaction,
  applyUserStopTransaction,
} from "@vex-agent/engine/runtime/lease-and-status.js";
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
    `INSERT INTO missions (id, root_session_id, status, goal, approved_at)
     VALUES ($1, $2, 'running', 'stop-for-edit precedence', NOW())`,
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

async function readMissionStatus(missionId: string): Promise<string | null> {
  const row = await queryOne<{ status: string }>(
    "SELECT status FROM missions WHERE id = $1",
    [missionId],
  );
  return row?.status ?? null;
}

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

describe("stop-for-edit vs a committed user Stop (integration, real clients)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("1. uncontended: the edit-stop wins the transition and demotes the mission", async () => {
    const seeded = await seedRunningMission();

    const applied = await applyStopForEditTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    expect(applied.outcome).toBe("stopped_for_edit");
    const run = await readRun(seeded.missionRunId);
    expect(run?.status).toBe("stopped");
    expect(run?.stop_reason).toBe("user_stopped");
    expect(await readMissionStatus(seeded.missionId)).toBe("draft");
    const mission = await queryOne<{ approved_at: Date | null }>(
      "SELECT approved_at FROM missions WHERE id = $1",
      [seeded.missionId],
    );
    expect(mission?.approved_at).toBeNull();
  });

  it("2. an ordinary Stop that committed FIRST is not overwritten and the mission stays cancelled", async () => {
    const seeded = await seedRunningMission();

    const stop = await applyUserStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    expect(stop.outcome).toBe("stopped");
    expect(await readMissionStatus(seeded.missionId)).toBe("cancelled");

    const edit = await applyStopForEditTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    expect(edit).toEqual({
      outcome: "lost_to_terminal",
      missionId: seeded.missionId,
      currentRunStatus: "stopped",
      missionStatus: "cancelled",
    });
    // The decisive assertion: NOT demoted to draft.
    expect(await readMissionStatus(seeded.missionId)).toBe("cancelled");
    const run = await readRun(seeded.missionRunId);
    expect(run?.status).toBe("stopped");
    expect(run?.stop_reason).toBe("user_stopped");
  });

  it("3. INTERLEAVING: an ordinary Stop commits inside the window the edit-stop used to read in", async () => {
    const seeded = await seedRunningMission();
    const order: string[] = [];

    // Reproduce the exact shape of the defect: the edit-stop's "is this run
    // still live?" observation happens, THEN an ordinary Stop commits, THEN the
    // edit-stop tries to write. The old code read outside any transaction, so
    // the write went through unconditionally. Holding the session control lock
    // from a separate client lets us place the Stop's commit precisely in that
    // window and prove the ordering, rather than hoping for a lucky schedule.
    const holder = await getPool().connect();
    await holder.query("BEGIN");
    await acquireSessionControlLock(holder, seeded.sessionId);
    order.push("edit:window_open");

    let stopCommitted = false;
    const ordinaryStop = applyUserStopTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    }).then((outcome) => {
      stopCommitted = true;
      order.push("stop:committed");
      return outcome;
    });

    // Provably blocked while the window is held.
    expect(await waitUntil(() => stopCommitted, 300)).toBe(false);
    order.push("edit:window_closed");
    await holder.query("COMMIT");
    holder.release();

    const stopOutcome = await ordinaryStop;
    expect(stopOutcome.outcome).toBe("stopped");

    // Now the edit-stop runs — with a view of the run that is already stale.
    const edit = await applyStopForEditTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    order.push("edit:applied");

    expect(order).toEqual([
      "edit:window_open",
      "edit:window_closed",
      "stop:committed",
      "edit:applied",
    ]);
    expect(edit.outcome).toBe("lost_to_terminal");
    expect(await readMissionStatus(seeded.missionId)).toBe("cancelled");
  });

  it("4. CONCURRENT: an edit-stop and an ordinary Stop racing produce exactly one winner", async () => {
    const seeded = await seedRunningMission();

    const [edit, stop] = await Promise.all([
      applyStopForEditTransaction({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
      }),
      applyUserStopTransaction({
        sessionId: seeded.sessionId,
        missionRunId: seeded.missionRunId,
      }),
    ]);

    // Both write the SAME run status pair, so the run row cannot identify the
    // winner — the discriminators can, and exactly one of them says "stopped".
    const editWon = edit.outcome === "stopped_for_edit";
    const stopWon = stop.outcome === "stopped";
    expect(editWon !== stopWon).toBe(true);

    const run = await readRun(seeded.missionRunId);
    expect(run?.status).toBe("stopped");
    expect(run?.stop_reason).toBe("user_stopped");
    // The mission row is the only place the winner is visible, and it agrees
    // with the discriminator — never a torn combination.
    expect(await readMissionStatus(seeded.missionId)).toBe(
      editWon ? "draft" : "cancelled",
    );
  });

  it("5. a second edit-stop for the same run reports `already_edited`, not a loss", async () => {
    const seeded = await seedRunningMission();

    const first = await applyStopForEditTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });
    const second = await applyStopForEditTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    expect(first.outcome).toBe("stopped_for_edit");
    // This is the abort.ts / mission-finalize.ts pair: one of them loses the
    // transition, but the operator's edit really did happen, so reporting
    // `already_terminal` to the UI would be untruthful.
    expect(second).toEqual({
      outcome: "already_edited",
      missionId: seeded.missionId,
      missionStatus: "draft",
    });
    expect(await readMissionStatus(seeded.missionId)).toBe("draft");
  });

  it("6. a business outcome that reached terminal first is not demoted either", async () => {
    const seeded = await seedRunningMission();
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE mission_runs SET status = 'completed', ended_at = NOW() WHERE id = $1",
        [seeded.missionRunId],
      );
      await client.query("UPDATE missions SET status = 'completed' WHERE id = $1", [
        seeded.missionId,
      ]);
    });

    const edit = await applyStopForEditTransaction({
      sessionId: seeded.sessionId,
      missionRunId: seeded.missionRunId,
    });

    expect(edit).toEqual({
      outcome: "lost_to_terminal",
      missionId: seeded.missionId,
      currentRunStatus: "completed",
      missionStatus: "completed",
    });
    expect(await readMissionStatus(seeded.missionId)).toBe("completed");
  });

  it("7. a vanished run is refused rather than written", async () => {
    const sessionId = await makeSession();
    const edit = await applyStopForEditTransaction({
      sessionId,
      missionRunId: "run-that-never-existed",
    });
    expect(edit).toEqual({ outcome: "run_not_found" });
  });
});
