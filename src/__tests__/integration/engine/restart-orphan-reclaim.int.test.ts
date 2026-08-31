/**
 * Integration: the restart-orphan reclaim, against REAL Postgres.
 *
 * The defect this covers is a crash: the app dies mid-slice and the run row
 * stays `running` forever while the lease that proved someone owned it quietly
 * expires. Every guarantee the reclaim makes is a statement about concurrent
 * rows and locks - a live lease beats the sweep, an exact CAS refuses a run
 * that moved, a queued operator Stop wins - and none of them can be shown with
 * a mocked client: there is no second transaction, no lock queue and no CAS.
 * So every proof below drives the real repo functions over real rows.
 *
 * What is proven:
 *   1. a crashed run (running, EXPIRED lease) is reclaimed once the lease has
 *      lapsed, with cause `restart_orphan` and a truthful summary;
 *   2. a crashed run with NO lease row at all is reclaimed too;
 *   3. a LIVE lease is never reclaimed, at either stage (candidate query and
 *      the locked re-read), and the run is left untouched for the next pass;
 *   4. two concurrent reclaims of the same run produce exactly ONE write;
 *   5. the pass is idempotent - a second sweep reclaims nothing;
 *   6. non-`running` rows (paused and terminal) are never written, which is
 *      what the exact CAS buys over `updateStatusIfNotTerminal`;
 *   7. a queued operator Stop is applied INSTEAD of the park, and the run ends
 *      terminal rather than recoverable;
 *   8. a freshly-started run is not a candidate (staleness floor).
 */

import { beforeEach, describe, expect, it } from "vitest";

import { query, queryOne } from "@vex-agent/db/client.js";
import { enqueueOperatorStopRequest } from "@vex-agent/engine/runtime/lease-and-status.js";
import {
  RESTART_ORPHAN_STOP_REASON,
  RESTART_ORPHAN_SUMMARY,
  findOrphanCandidates,
  reclaimOrphanedRun,
  runRestartOrphanReclaimPass,
} from "@vex-agent/engine/runtime/restart-orphan-reclaim.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

/** Both defaults are irrelevant to these rows; keep the sweep deterministic. */
const PASS = { limit: 50, minStaleMs: 0 } as const;

interface Seeded {
  readonly sessionId: string;
  readonly missionId: string;
  readonly runId: string;
}

async function seedRun(
  status: string,
  options: { readonly startedMinutesAgo?: number } = {},
): Promise<Seeded> {
  const sessionId = await makeSession();
  const missionId = `mission-${sessionId}`;
  const runId = `run-${sessionId}`;
  await query(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'restart-orphan integration')`,
    [missionId, sessionId],
  );
  await query(
    `INSERT INTO mission_runs (id, mission_id, session_id, status, started_at)
     VALUES ($1, $2, $3, $4, NOW() - ($5::int * interval '1 minute'))`,
    [runId, missionId, sessionId, status, options.startedMinutesAgo ?? 10],
  );
  return { sessionId, missionId, runId };
}

/** `expiresInMs` negative = an expired lease, exactly what a crash leaves. */
async function seedLease(
  seeded: Seeded,
  expiresInMs: number,
  ownerId = "owner-crashed",
): Promise<void> {
  await query(
    `INSERT INTO runner_leases
       (session_id, mission_run_id, owner_id, process_kind,
        acquired_at, heartbeat_at, expires_at)
     VALUES ($1, $2, $3, 'electron_main', NOW(), NOW(),
             NOW() + ($4::int * interval '1 millisecond'))`,
    [seeded.sessionId, seeded.runId, ownerId, expiresInMs],
  );
}

async function readRun(runId: string): Promise<{
  status: string;
  stop_reason: string | null;
  stop_summary: string | null;
  stop_evidence_json: Record<string, unknown> | null;
} | null> {
  return queryOne(
    `SELECT status, stop_reason, stop_summary, stop_evidence_json
       FROM mission_runs WHERE id = $1`,
    [runId],
  );
}

async function candidateFor(seeded: Seeded) {
  const candidates = await findOrphanCandidates(PASS);
  const found = candidates.find((c) => c.runId === seeded.runId);
  if (!found) throw new Error(`no candidate for ${seeded.runId}`);
  return found;
}

beforeEach(async () => {
  await resetDb();
});

describe("restart-orphan reclaim", () => {
  it("reclaims a crashed run once its lease has expired", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, -1_000);

    const summary = await runRestartOrphanReclaimPass(PASS);

    expect(summary.reclaimed).toBe(1);
    const row = await readRun(seeded.runId);
    expect(row?.status).toBe("paused_error");
    expect(row?.stop_reason).toBe(RESTART_ORPHAN_STOP_REASON);
    expect(row?.stop_summary).toBe(RESTART_ORPHAN_SUMMARY);
    // Truthful evidence: the lease we observed, not a guess.
    expect(row?.stop_evidence_json).toMatchObject({
      restartOrphan: { leaseObserved: true },
    });
  });

  it("reclaims a crashed run whose lease row is gone entirely", async () => {
    const seeded = await seedRun("running");

    const summary = await runRestartOrphanReclaimPass(PASS);

    expect(summary.reclaimed).toBe(1);
    const row = await readRun(seeded.runId);
    expect(row?.status).toBe("paused_error");
    expect(row?.stop_evidence_json).toMatchObject({
      restartOrphan: { leaseObserved: false, leaseExpiresAt: null },
    });
  });

  it("NEVER reclaims a run whose session holds a live lease", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, 5 * 60_000);

    // Stage 1: not even a candidate.
    const candidates = await findOrphanCandidates(PASS);
    expect(candidates.map((c) => c.runId)).not.toContain(seeded.runId);

    const summary = await runRestartOrphanReclaimPass(PASS);
    expect(summary.reclaimed).toBe(0);
    expect((await readRun(seeded.runId))?.status).toBe("running");
  });

  it("refuses under the lock when the lease is re-acquired after the candidate read", async () => {
    // The candidate read is a read of the PAST: a runner can come back between
    // the sweep's SELECT and its transaction. The locked re-read is what makes
    // the guarantee hold, and this is the only way to exercise it.
    const seeded = await seedRun("running");
    await seedLease(seeded, -1_000);
    const candidate = await candidateFor(seeded);

    await query("DELETE FROM runner_leases WHERE session_id = $1", [
      seeded.sessionId,
    ]);
    await seedLease(seeded, 5 * 60_000, "owner-returned");

    expect(await reclaimOrphanedRun(candidate)).toBe("lease_live");
    expect((await readRun(seeded.runId))?.status).toBe("running");
  });

  it("writes exactly once when two reclaims race the same run", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, -1_000);
    const candidate = await candidateFor(seeded);

    const [a, b] = await Promise.all([
      reclaimOrphanedRun(candidate),
      reclaimOrphanedRun(candidate),
    ]);

    expect([a, b].filter((o) => o === "reclaimed")).toHaveLength(1);
    expect([a, b].filter((o) => o === "not_running")).toHaveLength(1);
    expect((await readRun(seeded.runId))?.status).toBe("paused_error");
  });

  it("is idempotent across passes", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, -1_000);

    expect((await runRestartOrphanReclaimPass(PASS)).reclaimed).toBe(1);
    const second = await runRestartOrphanReclaimPass(PASS);

    expect(second.candidates).toBe(0);
    expect(second.reclaimed).toBe(0);
    expect((await readRun(seeded.runId))?.status).toBe("paused_error");
  });

  it.each([
    "paused_approval",
    "paused_user_form",
    "paused_wake",
    "completed",
    "stopped",
  ])("never touches a %s run", async (status) => {
    const seeded = await seedRun(status);
    await seedLease(seeded, -1_000);

    const summary = await runRestartOrphanReclaimPass(PASS);
    expect(summary.candidates).toBe(0);
    expect(summary.reclaimed).toBe(0);
    expect((await readRun(seeded.runId))?.status).toBe(status);
  });

  it("refuses the exact CAS when the run left `running` after the candidate read", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, -1_000);
    const candidate = await candidateFor(seeded);

    await query(
      "UPDATE mission_runs SET status = 'paused_approval' WHERE id = $1",
      [seeded.runId],
    );

    expect(await reclaimOrphanedRun(candidate)).toBe("not_running");
    // The whole point of the exact CAS: a live pause is not overwritten with
    // `paused_error`, which would strand whatever the pause was waiting for.
    const row = await readRun(seeded.runId);
    expect(row?.status).toBe("paused_approval");
    expect(row?.stop_reason).toBeNull();
  });

  it("applies a queued operator Stop instead of parking the run", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, -1_000);
    await enqueueOperatorStopRequest({
      sessionId: seeded.sessionId,
      missionRunId: seeded.runId,
      correlationId: "reclaim-stop-test",
    });

    const summary = await runRestartOrphanReclaimPass(PASS);

    expect(summary.reclaimed).toBe(0);
    const row = await readRun(seeded.runId);
    expect(row?.status).toBe("stopped");
    expect(row?.stop_reason).toBe("user_stopped");
  });

  it("leaves a freshly started run alone (staleness floor)", async () => {
    const seeded = await seedRun("running", { startedMinutesAgo: 0 });

    const candidates = await findOrphanCandidates({
      limit: 50,
      minStaleMs: 60_000,
    });

    expect(candidates.map((c) => c.runId)).not.toContain(seeded.runId);
  });
});
