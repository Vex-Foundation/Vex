/**
 * D2-T1 (delta-override, BINDING) — Stop revalidates its TARGET SCOPE inside
 * the session control lock.
 *
 * ## The hole
 *
 * `runStopDispatch` chooses "session scope" from a read taken BEFORE the stop
 * transaction. The start and recover paths claim the SESSION lease first and
 * commit the `mission_runs` row afterwards. So the CREATION-FIRST interleaving
 * was:
 *
 *   1. the dispatch reads "no active run" — stale from that instant on;
 *   2. start/recover commits the mission run;
 *   3. the session-stop transaction enqueues a request with
 *      `mission_run_id = NULL`;
 *   4. the run-scoped gate matches on `row.mission_run_id === missionRunId`, so
 *      a NULL-scoped row is NEVER found for a run;
 *   5. the run proceeds. The user pressed Stop on real money-moving work and
 *      nothing stopped.
 *
 * The stop-first ordering was already safe (the gate consumes the stop); this
 * file is the creation-first mirror.
 *
 * ## Why integration
 *
 * The property is an ORDER two real transactions produce under a real advisory
 * lock. A mocked `db/client.js` has one fake client, no lock queue and no
 * snapshot boundary, so it can express neither the bug nor the fix.
 *
 * `runStopDispatch` itself cannot run here — it imports electron. The engine
 * primitive it calls is the thing that owns the invariant, and it is what this
 * file drives; the IPC reroute on top of `active_run_exists` is pinned in
 * vex-app's own `request-stop.test.ts`.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, withTransaction } from "@vex-agent/db/client.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import {
  acquireSessionControlLock,
  enqueueOperatorStopRequest,
  enqueueSessionStopRequest,
  gateOnOperatorStopTransaction,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

async function seedMission(sessionId: string): Promise<string> {
  const missionId = `mission-${sessionId}`;
  await query(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'target-scope revalidation')`,
    [missionId, sessionId],
  );
  return missionId;
}

/**
 * Commit a mission run the way BOTH prepare paths now commit one: the session
 * control lock FIRST, then `createRun`, as one transaction.
 *
 * `recoveredFromRunId` is what distinguishes the two cases the override
 * requires to be covered separately — `mission-prepare.ts` (start) and
 * `recover-prepare.ts` (recover). The durable shape they produce, and the shape
 * this invariant is about, is otherwise identical.
 */
async function commitRunUnderSessionLock(input: {
  readonly sessionId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly recoveredFromRunId?: string;
}): Promise<void> {
  await withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);
    await missionRunsRepo.createRun(
      input.runId,
      input.missionId,
      input.sessionId,
      input.recoveredFromRunId === undefined
        ? {}
        : { recoveredFromRunId: input.recoveredFromRunId },
      client,
    );
  });
}

/** A terminal predecessor for the recover shape's FK to point at. */
async function seedFailedRun(
  sessionId: string,
  missionId: string,
  runId: string,
): Promise<string> {
  await query(
    `INSERT INTO mission_runs (id, mission_id, session_id, status)
     VALUES ($1, $2, $3, 'failed')`,
    [runId, missionId, sessionId],
  );
  return runId;
}

/** Open (pending|observed) SESSION-scoped stop requests — the forbidden shape. */
async function openSessionScopedStops(sessionId: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(
    `SELECT id FROM runtime_control_requests
      WHERE session_id = $1 AND kind = 'stop_terminal'
        AND mission_run_id IS NULL AND status IN ('pending','observed')`,
    [sessionId],
  );
}

async function readRunStatus(runId: string): Promise<string | null> {
  const rows = await query<{ status: string }>(
    "SELECT status FROM mission_runs WHERE id = $1",
    [runId],
  );
  return rows[0]?.status ?? null;
}

describe("session stop — target-scope revalidation (D2-T1)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  for (const shape of ["start", "recover"] as const) {
    describe(`creation-first via ${shape}`, () => {
      it("refuses session scope and names the run instead", async () => {
        const sessionId = await makeSession();
        const missionId = await seedMission(sessionId);

        // (1) The dispatch's read happens HERE — no run exists yet, so it
        //     chose SESSION scope. Everything after this makes it stale.
        expect(await missionRunsRepo.getActiveRunBySession(sessionId)).toBeNull();

        // (2) start/recover commits the run.
        const runId = `run-${shape}-${sessionId}`;
        const recovered = shape === "recover"
          ? {
            recoveredFromRunId: await seedFailedRun(
              sessionId,
              missionId,
              `old-${sessionId}`,
            ),
          }
          : {};
        await commitRunUnderSessionLock({
          sessionId,
          missionId,
          runId,
          ...recovered,
        });

        // (3) Stop is pressed with the stale session scope.
        const outcome = await enqueueSessionStopRequest({
          sessionId,
          correlationId: "d2-t1",
        });

        // The engine revalidated under the lock and handed the run back
        // instead of writing a request the run-scoped gate could never find.
        expect(outcome).toEqual({
          outcome: "active_run_exists",
          missionRunId: runId,
          runStatus: "running",
        });

        // THE INVARIANT: no open NULL-scoped row for a session with an active
        // run. Ever.
        expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
      });

      it("the rerouted RUN-scoped stop actually stops that run", async () => {
        const sessionId = await makeSession();
        const missionId = await seedMission(sessionId);
        const runId = `run-${shape}-reroute-${sessionId}`;
        const recovered = shape === "recover"
          ? {
            recoveredFromRunId: await seedFailedRun(
              sessionId,
              missionId,
              `old-${sessionId}`,
            ),
          }
          : {};
        await commitRunUnderSessionLock({
          sessionId,
          missionId,
          runId,
          ...recovered,
        });

        const rejected = await enqueueSessionStopRequest({ sessionId });
        expect(rejected.outcome).toBe("active_run_exists");

        // What main does with `active_run_exists`: re-run the RUN-scoped path,
        // exactly once. `enqueueOperatorStopRequest` re-locks the run in its own
        // transaction, which is the terminating condition — not a retry budget.
        const queued = await enqueueOperatorStopRequest({
          sessionId,
          missionRunId: runId,
          correlationId: "d2-t1-reroute",
        });
        expect(queued.outcome).toBe("queued");

        // A runner observing its gate lands the stop on THAT run.
        const gate = await gateOnOperatorStopTransaction({
          sessionId,
          missionRunId: runId,
        });
        expect(gate.kind).toBe("stopped");
        expect(await readRunStatus(runId)).toBe("stopped");
        // And still no session-scoped row anywhere in the flow.
        expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
      });
    });
  }

  /**
   * Both transactions take the session control lock, so there is no third
   * ordering — and the invariant holds for either of the two.
   */
  it("a run creation racing the Stop leaves no NULL-scoped row, whichever wins", async () => {
    const sessionId = await makeSession();
    const missionId = await seedMission(sessionId);
    const runId = `run-race-${sessionId}`;

    await Promise.all([
      commitRunUnderSessionLock({ sessionId, missionId, runId }),
      enqueueSessionStopRequest({ sessionId, correlationId: "d2-race" }),
    ]);

    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
  });

  /**
   * A TERMINAL run is not an active run: it cannot observe anything, so the
   * session-scoped path is the correct target and the revalidation must not
   * hijack it.
   */
  it("a terminal run does not divert the session-scoped stop", async () => {
    const sessionId = await makeSession();
    const missionId = await seedMission(sessionId);
    const runId = `run-done-${sessionId}`;
    await commitRunUnderSessionLock({ sessionId, missionId, runId });
    await query("UPDATE mission_runs SET status = 'completed' WHERE id = $1", [runId]);

    const outcome = await enqueueSessionStopRequest({ sessionId });

    expect(outcome.outcome).not.toBe("active_run_exists");
  });
});
