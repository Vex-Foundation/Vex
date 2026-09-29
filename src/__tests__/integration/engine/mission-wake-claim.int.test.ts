/**
 * Integration: the atomic mission wake claim and the stuck-wake repair,
 * against REAL Postgres (a disposable testcontainers database).
 *
 * The defect: the executor used to consume every due mission wake in one batch
 * and only then start the runs, one by one. A crash after the first start left
 * every later row consumed and its run parked in `paused_wake` forever. Every
 * guarantee below is a statement about transactions, row locks and the session
 * control lock, so none of it can be shown with a mocked client.
 *
 * What is proven:
 *   1. a crash after the FIRST claim leaves the other due wakes pending; a
 *      restarted tick starts each of them exactly once;
 *   2. a failure INSIDE a claim (after the row was consumed and the run
 *      flipped, before commit) consumes nothing and flips nothing;
 *   3. two concurrent ticks never start the same run twice;
 *   4. a run whose own turn loop has not parked yet, or whose lease is busy,
 *      keeps its wake pending (pushed out), never dropped - and an auto-retry
 *      epoch in `attempt` survives the deferral;
 *   5. a run the wake can no longer resume has its row retired as cancelled,
 *      never consumed;
 *   6. the repair sweep re-arms a pre-fix stuck run exactly once (sequential
 *      and concurrent), never repairs its own repair, skips owned / pending /
 *      cancelled / fresh shapes, and yields to a queued operator Stop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { execute, query, queryOne } from "@vex-agent/db/client.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import { enqueueOperatorStopRequest } from "@vex-agent/engine/runtime/lease-and-status.js";
import { tick, type WakeDeps } from "@vex-agent/engine/wake/executor.js";
import { claimMissionWakeAtomically } from "@vex-agent/engine/wake/executor/claim-mission-wake.js";
import { claimSessionWakeAtomically } from "@vex-agent/engine/wake/executor/claim-session-wake.js";
import {
  STUCK_WAKE_REPAIR_KEY,
  findStuckWakeCandidates,
  repairStuckWake,
  runStuckWakeRepairPass,
} from "@vex-agent/engine/wake/stuck-wake-repair.js";
import { requireValue } from "../../helpers/require-value.js";
import type { RunnerLeaseGuard } from "@vex-agent/engine/runtime/lease-guard.js";
import { makeSession, resetDb } from "../setup/fixtures.js";

interface Seeded {
  readonly sessionId: string;
  readonly runId: string;
}

interface WakeRow {
  readonly id: string;
  readonly status: string;
  readonly due_at: Date;
  readonly reason: string | null;
  readonly payload: Record<string, unknown> | null;
  readonly cancelled_reason: string | null;
}

async function seedRun(status: string): Promise<Seeded> {
  const sessionId = await makeSession();
  const missionId = `mission-${sessionId}`;
  const runId = `run-${sessionId}`;
  await query(
    `INSERT INTO missions (id, root_session_id, status, goal)
     VALUES ($1, $2, 'running', 'mission wake claim integration')`,
    [missionId, sessionId],
  );
  await query(
    `INSERT INTO mission_runs (id, mission_id, session_id, status, started_at)
     VALUES ($1, $2, $3, $4, NOW() - interval '10 minutes')`,
    [runId, missionId, sessionId, status],
  );
  return { sessionId, runId };
}

/** A wake due `dueSecondsAgo` in the past. */
async function seedWake(
  seeded: Seeded,
  dueSecondsAgo: number,
  payload: Record<string, unknown> | null = null,
): Promise<string> {
  const row = await loopWakeRepo.enqueue({
    sessionId: seeded.sessionId,
    missionRunId: seeded.runId,
    dueAt: new Date(Date.now() - dueSecondsAgo * 1000),
    reason: "re-check the position",
    payload,
  });
  return requireValue(row).id;
}

async function seedLease(seeded: Seeded, ownerId: string): Promise<void> {
  await query(
    `INSERT INTO runner_leases
       (session_id, mission_run_id, owner_id, process_kind,
        acquired_at, heartbeat_at, expires_at)
     VALUES ($1, $2, $3, 'electron_main', NOW(), NOW(), NOW() + interval '5 minutes')`,
    [seeded.sessionId, seeded.runId, ownerId],
  );
}

async function runStatus(runId: string): Promise<string> {
  const row = await queryOne<{ status: string }>(
    "SELECT status FROM mission_runs WHERE id = $1",
    [runId],
  );
  return requireValue(row).status;
}

async function wakesFor(runId: string): Promise<WakeRow[]> {
  return query<WakeRow>(
    `SELECT id, status, due_at, reason, payload, cancelled_reason
       FROM loop_wake_requests WHERE mission_run_id = $1
      ORDER BY created_at ASC, id ASC`,
    [runId],
  );
}

async function wakeStatus(wakeId: string): Promise<string> {
  const row = await queryOne<{ status: string }>(
    "SELECT status FROM loop_wake_requests WHERE id = $1",
    [wakeId],
  );
  return requireValue(row).status;
}

async function leaseOwner(sessionId: string): Promise<string | null> {
  const row = await queryOne<{ owner_id: string }>(
    "SELECT owner_id FROM runner_leases WHERE session_id = $1",
    [sessionId],
  );
  return row?.owner_id ?? null;
}

function makeDeps(overrides: Partial<WakeDeps> = {}): WakeDeps {
  return {
    listDueMissionWakes: (now, limit) =>
      loopWakeRepo.listDueMissionScoped(now, limit),
    claimMissionWake: (input) => claimMissionWakeAtomically(input),
    listDueSessionWakes: (now, limit) =>
      loopWakeRepo.listDueSessionScoped(now, limit),
    claimSessionWake: (input) => claimSessionWakeAtomically(input),
    injectWakeBanner: vi.fn().mockResolvedValue(undefined),
    resumeMissionRun: vi.fn().mockResolvedValue(undefined),
    continueAgentSession: vi.fn().mockResolvedValue(undefined),
    isProviderReady: () => true,
    ...overrides,
  };
}

const FAIL_LEASE_TRIGGER = "mission_wake_claim_fail_lease";

async function dropFailLeaseTrigger(): Promise<void> {
  await execute(`DROP TRIGGER IF EXISTS ${FAIL_LEASE_TRIGGER} ON runner_leases`);
  await execute(`DROP FUNCTION IF EXISTS ${FAIL_LEASE_TRIGGER}()`);
}

describe("mission wake claim (integration)", () => {
  beforeEach(async () => {
    await dropFailLeaseTrigger();
    await resetDb();
  });

  afterEach(async () => {
    await dropFailLeaseTrigger();
  });

  // ── 1. Crash between claims ─────────────────────────────────────

  it("a crash after the first claim leaves the other due wakes pending; a restart starts each exactly once", async () => {
    const first = await seedRun("paused_wake");
    const second = await seedRun("paused_wake");
    const third = await seedRun("paused_wake");
    const firstWake = await seedWake(first, 30);
    const secondWake = await seedWake(second, 20);
    const thirdWake = await seedWake(third, 10);

    // The crashed process: its first resume never returns. From the database's
    // point of view the process is gone at this point - nothing after the
    // first claim has been committed by it.
    let unfreeze: () => void = () => {};
    const frozen = new Promise<void>((resolve) => {
      unfreeze = resolve;
    });
    const crashedResume = vi.fn((_runId: string, _owner: RunnerLeaseGuard) => frozen);
    const crashedPass = tick(new Date(), 10, makeDeps({ resumeMissionRun: crashedResume }));
    await vi.waitFor(() => expect(crashedResume).toHaveBeenCalledTimes(1));

    expect(crashedResume).toHaveBeenCalledWith(first.runId, expect.objectContaining({ ownerId: `wake-executor-${firstWake}` }));
    expect(await wakeStatus(firstWake)).toBe("consumed");
    expect(await runStatus(first.runId)).toBe("running");
    // The rows the old batch claim would have consumed are untouched.
    expect(await wakeStatus(secondWake)).toBe("pending");
    expect(await wakeStatus(thirdWake)).toBe("pending");
    expect(await runStatus(second.runId)).toBe("paused_wake");
    expect(await runStatus(third.runId)).toBe("paused_wake");
    expect(await leaseOwner(second.sessionId)).toBeNull();

    // Restart: a fresh executor pass.
    const restartedResume = vi.fn((_runId: string, _owner: RunnerLeaseGuard) => Promise.resolve());
    const results = await tick(new Date(), 10, makeDeps({ resumeMissionRun: restartedResume }));

    expect(results.map((r) => r.outcome)).toEqual([
      { kind: "resumed", runId: second.runId },
      { kind: "resumed", runId: third.runId },
    ]);
    expect(restartedResume.mock.calls).toEqual([
      [second.runId, expect.objectContaining({ ownerId: `wake-executor-${secondWake}` })],
      [third.runId, expect.objectContaining({ ownerId: `wake-executor-${thirdWake}` })],
    ]);
    expect(await wakeStatus(secondWake)).toBe("consumed");
    expect(await wakeStatus(thirdWake)).toBe("consumed");

    // A second restart finds nothing to do.
    expect(await tick(new Date(), 10, makeDeps({ resumeMissionRun: restartedResume }))).toEqual([]);
    expect(restartedResume).toHaveBeenCalledTimes(2);

    // Let the frozen pass drain. It listed all three rows before it froze; the
    // two it never claimed were claimed by the restart, so it starts nothing.
    unfreeze();
    const drained = await crashedPass;
    expect(drained.map((r) => r.outcome.kind)).toEqual([
      "resumed",
      "skipped_claim_lost",
      "skipped_claim_lost",
    ]);
    expect(crashedResume).toHaveBeenCalledTimes(1);
  });

  // ── 2. Failure inside the claim ─────────────────────────────────

  it("a failure inside the claim transaction consumes nothing and flips nothing", async () => {
    const broken = await seedRun("paused_wake");
    const healthy = await seedRun("paused_wake");
    const brokenWake = await seedWake(broken, 20);
    const healthyWake = await seedWake(healthy, 10);

    // Fail the LAST step of the claim (the lease write) for one session only:
    // by then the row is consumed and the run flipped inside the transaction.
    await execute(
      `CREATE FUNCTION ${FAIL_LEASE_TRIGGER}() RETURNS trigger AS $$
       BEGIN
         IF NEW.session_id = '${broken.sessionId}' THEN
           RAISE EXCEPTION 'injected lease failure';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`,
    );
    await execute(
      `CREATE TRIGGER ${FAIL_LEASE_TRIGGER} BEFORE INSERT OR UPDATE ON runner_leases
       FOR EACH ROW EXECUTE FUNCTION ${FAIL_LEASE_TRIGGER}()`,
    );

    const resume = vi.fn((_runId: string, _owner: RunnerLeaseGuard) => Promise.resolve());
    const results = await tick(new Date(), 10, makeDeps({ resumeMissionRun: resume }));

    expect(results.map((r) => r.outcome.kind)).toEqual(["error", "resumed"]);
    expect(await wakeStatus(brokenWake)).toBe("pending");
    expect(await runStatus(broken.runId)).toBe("paused_wake");
    expect(await leaseOwner(broken.sessionId)).toBeNull();
    expect(await wakeStatus(healthyWake)).toBe("consumed");
    expect(resume.mock.calls).toEqual([[healthy.runId, expect.objectContaining({ ownerId: `wake-executor-${healthyWake}` })]]);

    // Once the fault clears, the untouched row is claimed normally.
    await dropFailLeaseTrigger();
    const retry = await tick(new Date(), 10, makeDeps({ resumeMissionRun: resume }));
    expect(retry.map((r) => r.outcome)).toEqual([
      { kind: "resumed", runId: broken.runId },
    ]);
    expect(await wakeStatus(brokenWake)).toBe("consumed");
  });

  // ── 3. Concurrent ticks ─────────────────────────────────────────

  it("two concurrent ticks start every due run exactly once", async () => {
    const runs = [
      await seedRun("paused_wake"),
      await seedRun("paused_wake"),
      await seedRun("paused_wake"),
    ];
    for (const [index, seeded] of runs.entries()) {
      await seedWake(seeded, 30 - index);
    }

    const started: string[] = [];
    const resume = vi.fn(async (runId: string, _owner: RunnerLeaseGuard) => {
      started.push(runId);
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    const now = new Date();
    const [a, b] = await Promise.all([
      tick(now, 10, makeDeps({ resumeMissionRun: resume })),
      tick(now, 10, makeDeps({ resumeMissionRun: resume })),
    ]);

    expect([...started].sort()).toEqual(runs.map((r) => r.runId).sort());
    const resumed = [...a, ...b].filter((r) => r.outcome.kind === "resumed");
    expect(resumed).toHaveLength(3);
    for (const seeded of runs) {
      const rows = await wakesFor(seeded.runId);
      expect(rows.map((row) => row.status)).toEqual(["consumed"]);
    }
  });

  // ── 4. Deferral instead of loss ─────────────────────────────────

  it("a run still unwinding toward its park keeps its wake pending, with the retry epoch intact", async () => {
    const seeded = await seedRun("running");
    await seedLease(seeded, "turn-loop-owner");
    const wakeId = await seedWake(seeded, 1, { attempt: 2 });

    const resume = vi.fn((_runId: string, _owner: RunnerLeaseGuard) => Promise.resolve());
    const now = new Date();
    const results = await tick(now, 10, makeDeps({ resumeMissionRun: resume }));

    expect(results.map((r) => r.outcome.kind)).toEqual(["deferred_lease_busy"]);
    const [row] = await wakesFor(seeded.runId);
    expect(requireValue(row).status).toBe("pending");
    expect(requireValue(row).payload).toEqual({ attempt: 2, claimAttempt: 1 });
    expect(requireValue(row).due_at.getTime()).toBe(now.getTime() + 5_000);
    expect(await runStatus(seeded.runId)).toBe("running");
    expect(await leaseOwner(seeded.sessionId)).toBe("turn-loop-owner");
    expect(resume).not.toHaveBeenCalled();

    // The turn loop parks and lets go; the SAME row then resumes the run.
    await execute("UPDATE mission_runs SET status = 'paused_wake' WHERE id = $1", [seeded.runId]);
    await execute("DELETE FROM runner_leases WHERE session_id = $1", [seeded.sessionId]);
    const later = await tick(new Date(now.getTime() + 6_000), 10, makeDeps({ resumeMissionRun: resume }));
    expect(later.map((r) => r.outcome)).toEqual([{ kind: "resumed", runId: seeded.runId }]);
    expect(resume.mock.calls).toEqual([[seeded.runId, expect.objectContaining({ ownerId: `wake-executor-${wakeId}` })]]);
  });

  it("a busy lease on a parked run defers the wake instead of dropping it", async () => {
    const seeded = await seedRun("paused_wake");
    await seedLease(seeded, "approval-resume-owner");
    const wakeId = await seedWake(seeded, 1);

    const results = await tick(new Date(), 10, makeDeps());

    expect(results.map((r) => r.outcome.kind)).toEqual(["deferred_lease_busy"]);
    expect(await wakeStatus(wakeId)).toBe("pending");
    expect(await runStatus(seeded.runId)).toBe("paused_wake");
    expect(await leaseOwner(seeded.sessionId)).toBe("approval-resume-owner");
  });

  // ── 5. Not resumable ────────────────────────────────────────────

  it("a terminal run's wake is retired as cancelled, never consumed", async () => {
    const seeded = await seedRun("completed");
    const wakeId = await seedWake(seeded, 1);
    const resume = vi.fn((_runId: string, _owner: RunnerLeaseGuard) => Promise.resolve());

    const results = await tick(new Date(), 10, makeDeps({ resumeMissionRun: resume }));

    expect(results.map((r) => r.outcome)).toEqual([
      { kind: "skipped_stale_status", currentStatus: "completed" },
    ]);
    const [row] = await wakesFor(seeded.runId);
    expect(requireValue(row).id).toBe(wakeId);
    expect(requireValue(row).status).toBe("cancelled");
    expect(requireValue(row).cancelled_reason).toBe("wake_not_resumable:not_resumable");
    expect(resume).not.toHaveBeenCalled();
    expect(await leaseOwner(seeded.sessionId)).toBeNull();
  });
});

// ── Stuck-wake repair ───────────────────────────────────────────────

/** The pre-fix crash shape: parked run, its only wake consumed long ago. */
async function seedStuck(
  payload: Record<string, unknown> | null = { triggeredBy: null, claimAttempt: 3 },
): Promise<Seeded & { readonly lostWakeId: string }> {
  const seeded = await seedRun("paused_wake");
  const lostWakeId = await seedWake(seeded, 600, payload);
  await execute(
    `UPDATE loop_wake_requests
        SET status = 'consumed', consumed_at = NOW() - interval '5 minutes'
      WHERE id = $1`,
    [lostWakeId],
  );
  return { ...seeded, lostWakeId };
}

const PASS = { limit: 50, minStaleMs: 60_000 } as const;

describe("stuck-wake repair (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("re-arms a pre-fix stuck run exactly once, and the executor then resumes it once", async () => {
    const stuck = await seedStuck();

    const firstPass = await runStuckWakeRepairPass(PASS);
    expect(firstPass).toEqual({ candidates: 1, rearmed: 1, skipped: 0, failed: 0 });

    const rows = await wakesFor(stuck.runId);
    expect(rows.map((row) => row.status)).toEqual(["consumed", "pending"]);
    const rearmed = requireValue(rows[1]);
    expect(rearmed.reason).toBe("re-check the position");
    expect(rearmed.payload).toEqual({
      triggeredBy: null,
      [STUCK_WAKE_REPAIR_KEY]: stuck.lostWakeId,
    });
    // Nothing was started by the sweep itself.
    expect(await runStatus(stuck.runId)).toBe("paused_wake");
    expect(await leaseOwner(stuck.sessionId)).toBeNull();

    // Idempotent: the next pass finds nothing.
    expect(await runStuckWakeRepairPass(PASS)).toEqual({
      candidates: 0,
      rearmed: 0,
      skipped: 0,
      failed: 0,
    });

    // The ordinary executor claims the re-armed row.
    const resume = vi.fn((_runId: string, _owner: RunnerLeaseGuard) => Promise.resolve());
    const results = await tick(new Date(), 10, makeDeps({ resumeMissionRun: resume }));
    expect(results.map((r) => r.outcome)).toEqual([{ kind: "resumed", runId: stuck.runId }]);
    expect(resume).toHaveBeenCalledTimes(1);

    // Even if the run somehow re-parks with only the consumed REPAIR row
    // behind it, the repair is never repaired: no restart loop.
    await execute("UPDATE mission_runs SET status = 'paused_wake' WHERE id = $1", [stuck.runId]);
    await execute(
      "UPDATE loop_wake_requests SET consumed_at = NOW() - interval '5 minutes' WHERE id = $1",
      [rearmed.id],
    );
    expect(await findStuckWakeCandidates(PASS)).toEqual([]);
    expect(
      await repairStuckWake({
        runId: stuck.runId,
        sessionId: stuck.sessionId,
        lostWakeId: rearmed.id,
      }),
    ).toBe("not_stuck");
  });

  it("two concurrent repairs of the same run re-arm it once", async () => {
    const stuck = await seedStuck();
    const candidate = {
      runId: stuck.runId,
      sessionId: stuck.sessionId,
      lostWakeId: stuck.lostWakeId,
    };

    const outcomes = await Promise.all([
      repairStuckWake(candidate),
      repairStuckWake(candidate),
    ]);

    expect([...outcomes].sort()).toEqual(["not_stuck", "rearmed"]);
    const pending = (await wakesFor(stuck.runId)).filter((row) => row.status === "pending");
    expect(pending).toHaveLength(1);
  });

  it("leaves owned, pending, deliberately cancelled and fresh shapes alone", async () => {
    const owned = await seedStuck();
    await seedLease(owned, "live-runner");

    const pending = await seedStuck();
    await seedWake(pending, 1);

    const cancelled = await seedRun("paused_wake");
    const cancelledWake = await seedWake(cancelled, 600);
    await loopWakeRepo.cancelForSession(cancelled.sessionId, "user_preempt");

    const fresh = await seedRun("paused_wake");
    const freshWake = await seedWake(fresh, 1);
    await execute(
      "UPDATE loop_wake_requests SET status = 'consumed', consumed_at = NOW() WHERE id = $1",
      [freshWake],
    );

    expect(await runStuckWakeRepairPass(PASS)).toEqual({
      candidates: 0,
      rearmed: 0,
      skipped: 0,
      failed: 0,
    });
    // The locked re-check agrees with the candidate read for the owned run.
    expect(
      await repairStuckWake({
        runId: owned.runId,
        sessionId: owned.sessionId,
        lostWakeId: owned.lostWakeId,
      }),
    ).toBe("lease_live");
    expect(await wakeStatus(cancelledWake)).toBe("cancelled");
    expect((await wakesFor(owned.runId)).map((row) => row.status)).toEqual(["consumed"]);
  });

  it("applies a queued operator Stop instead of re-arming", async () => {
    const stuck = await seedStuck();
    const queued = await enqueueOperatorStopRequest({
      sessionId: stuck.sessionId,
      missionRunId: stuck.runId,
    });
    expect(queued.outcome).toBe("queued");

    const outcome = await repairStuckWake({
      runId: stuck.runId,
      sessionId: stuck.sessionId,
      lostWakeId: stuck.lostWakeId,
    });

    expect(outcome).toBe("operator_stopped");
    expect(await runStatus(stuck.runId)).not.toBe("paused_wake");
    expect((await wakesFor(stuck.runId)).map((row) => row.status)).toEqual(["consumed"]);
  });
});
