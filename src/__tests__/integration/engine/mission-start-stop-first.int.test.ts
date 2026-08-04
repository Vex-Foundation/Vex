/**
 * Integration: the STOP-FIRST half of the run-creation ordering.
 *
 * `session-stop-target-scope.int.test.ts` covers CREATION-FIRST — a run
 * committed after the dispatch chose "session scope", where the stop
 * transaction revalidates and reroutes. This file covers the other ordering:
 * the operator's Stop commits FIRST, and a start/recover must then refuse to
 * create a run at all.
 *
 * ## Why refusing is the only safe answer
 *
 * A run created after a session-scoped `stop_terminal` is unreachable by that
 * stop: `operator-stop-boundary.ts` matches a run-scoped gate on
 * `row.mission_run_id === missionRunId`, so a NULL-scoped row is never found
 * for a run. The run would proceed with the operator's Stop sitting open and
 * inert — the same "pressed Stop, nothing stopped" failure from the other
 * direction.
 *
 * ## And why the refusal consumes the stop
 *
 * The gate APPLIES the stop in the same transaction. A refusal that left the
 * request open would make the session permanently un-startable, and would also
 * leave a row for some later, unrelated work to trip over. So the honest
 * contract is "your Stop landed first — start again", and the retry succeeds.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, withTransaction } from "@vex-agent/db/client.js";
import {
  acquireSessionControlLock,
  claimSessionLease,
  enqueueSessionStopRequest,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/**
 * The run-creation gate exactly as `commitMissionStart` and
 * `recover-prepare` now run it: session control lock FIRST, then the
 * session-scoped stop gate, then (only if clear) the run write.
 *
 * Driving the gate directly rather than `prepareMissionStart` keeps this test
 * about the ORDERING property; the outcome plumbing through
 * `PrepareMissionStartOutcome` → `MissionStartResult` is pinned by the
 * vex-app handler tests, and a full start needs an accepted mission, a
 * provider and a config that say nothing about this invariant.
 */
async function runCreationGate(
  sessionId: string,
): Promise<"session_stop_pending" | "clear"> {
  return withTransaction(async (client) => {
    await acquireSessionControlLock(client, sessionId);
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId: null,
    });
    return gate.kind === "stopped" ? "session_stop_pending" : "clear";
  });
}

async function openSessionScopedStops(sessionId: string): Promise<{ id: string }[]> {
  return query<{ id: string }>(
    `SELECT id FROM runtime_control_requests
      WHERE session_id = $1 AND kind = 'stop_terminal'
        AND mission_run_id IS NULL AND status IN ('pending','observed')`,
    [sessionId],
  );
}

describe("run creation — stop-first refusal", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("refuses to create a run while a session-scoped Stop is open", async () => {
    const sessionId = await makeSession();
    // A live lease is what makes the stop retain its request — the state every
    // real caller of the stop path is in.
    await claimSessionLease({
      sessionId,
      ownerId: "airborne-slice",
      processKind: "electron_main",
      ttlMs: 60_000,
    });
    const stop = await enqueueSessionStopRequest({ sessionId });
    expect(stop.outcome).toBe("queued");

    expect(await runCreationGate(sessionId)).toBe("session_stop_pending");
  });

  it("CONSUMES the stop, so the retry starts normally", async () => {
    const sessionId = await makeSession();
    await claimSessionLease({
      sessionId,
      ownerId: "airborne-slice",
      processKind: "electron_main",
      ttlMs: 60_000,
    });
    await enqueueSessionStopRequest({ sessionId });

    expect(await runCreationGate(sessionId)).toBe("session_stop_pending");

    // Nothing is parked for later work to trip over…
    expect(await openSessionScopedStops(sessionId)).toHaveLength(0);
    // …and the very next attempt proceeds.
    expect(await runCreationGate(sessionId)).toBe("clear");
  });

  it("does not refuse a session with no Stop outstanding", async () => {
    const sessionId = await makeSession();

    expect(await runCreationGate(sessionId)).toBe("clear");
  });

  /**
   * A RUN-scoped stop belongs to some other run and is not this creation's to
   * consume or to be refused by.
   */
  it("ignores a run-scoped stop for a different run", async () => {
    const sessionId = await makeSession();
    const missionId = `mission-${sessionId}`;
    const otherRunId = `run-other-${sessionId}`;
    await query(
      `INSERT INTO missions (id, root_session_id, status, goal)
       VALUES ($1, $2, 'running', 'stop-first ordering')`,
      [missionId, sessionId],
    );
    await query(
      `INSERT INTO mission_runs (id, mission_id, session_id, status)
       VALUES ($1, $2, $3, 'running')`,
      [otherRunId, missionId, sessionId],
    );
    await query(
      `INSERT INTO runtime_control_requests
         (session_id, mission_run_id, kind, requested_by, status)
       VALUES ($1, $2, 'stop_terminal', 'user', 'pending')`,
      [sessionId, otherRunId],
    );

    expect(await runCreationGate(sessionId)).toBe("clear");
  });
});
