/**
 * Integration: memory_jobs `retired` status is a DEAD END — no claim or
 * recovery path can ever revive a retired row back to `pending` (Agent Scan W4).
 *
 * Migration 044 terminalizes every non-terminal (`pending`/`running`/`failed`)
 * `reconcile` job to a new terminal `status='retired'` once the async S7
 * reconcile worker + its enqueue paths were deleted (`memory/ledger-wake.ts`,
 * `engine/memory-manager/reconcile.ts`). This suite pins the DB-level
 * invariant directly against `db/repos/memory-jobs/crud.ts`:
 *   - `claimNextDueJob` only selects `status IN ('pending','failed')` (and, as
 *     of FIX2-SPINE C19, `job_kind='consolidate'` too) — a retired row is
 *     neither, so it can never reach `running` again, even when it is the
 *     OLDEST due-looking row in the queue.
 *   - `recoverStaleRunning` only touches `status = 'running'` rows — a retired
 *     row is untouched regardless of how stale its heartbeat is.
 *
 * FIX2-SPINE C19 (Codex final-review finding 4) removed `enqueueReconcileJob`
 * and `resetReconcileJob` from the repo's public surface entirely — they were
 * this file's OTHER two invariants ("resetReconcileJob refuses a retired row";
 * "enqueueReconcileJob's conflict path never revives one"), and both tests are
 * removed with them: there is no longer a function call to make the
 * assertion against. The invariant they protected is not weakened — it is now
 * a STRONGER, structural guarantee: no exported memory_jobs primitive can even
 * attempt to write a fresh 'reconcile' row or reset one back to pending, so a
 * retired row cannot be revived by ANY caller, not merely by the two removed
 * functions' own defensive checks.
 *
 * The two remaining tests below now seed their reconcile row via raw SQL
 * (the shape `enqueueReconcileJob` used to produce) instead of the removed
 * function — seeding mechanics changed, assertions did not.
 *
 * Runs against the ephemeral pgvector container from `setup/globalSetup.ts`.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import {
  enqueueConsolidateJob,
  claimNextDueJob,
  getJobById,
  recoverStaleRunning,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import { resetDb } from "../setup/fixtures.js";
import { seedKnowledgeEntry } from "./_s1c-fixtures.js";

/**
 * Seed a pending reconcile row directly (raw SQL) — the same shape
 * `enqueueReconcileJob` used to insert, without going through the now-removed
 * repo function.
 */
async function seedPendingReconcileJob(
  entryId: number,
  outcomeVersion: number,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO memory_jobs (job_kind, reconcile_entry_id, reconcile_outcome_version)
     VALUES ('reconcile', $1, $2) RETURNING id`,
    [entryId, outcomeVersion],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("seedPendingReconcileJob: insert returned no row");
  return id;
}

/**
 * Retire a reconcile job exactly as migration 044's own UPDATE does (same
 * predicate, applied to one row by id rather than the bulk WHERE clause).
 */
async function retireJob(jobId: number): Promise<void> {
  await execute(`UPDATE memory_jobs SET status = 'retired' WHERE id = $1`, [jobId]);
}

describe("memory_jobs retired status — claim/reset/recovery dead end (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("claimNextDueJob never claims a retired job, even when it is the oldest due-looking row", async () => {
    const entryId = await seedKnowledgeEntry("retired-claim");
    const reconcileJobId = await seedPendingReconcileJob(entryId, 0);
    await retireJob(reconcileJobId);

    // A consolidate job enqueued AFTER the retired row — FIFO would normally
    // prefer the older row, so claiming the newer one proves retired is
    // structurally excluded, not merely deprioritized.
    const consolidateJob = await enqueueConsolidateJob();

    const claimed = await claimNextDueJob("w-retired-claim");
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(consolidateJob.id);
    expect(claimed!.id).not.toBe(reconcileJobId);

    // The retired row is untouched by the claim attempt.
    const after = await getJobById(reconcileJobId);
    expect(after!.status).toBe("retired");
    expect(after!.lockedBy).toBeNull();

    // Claiming again finds nothing further — the retired row is the only
    // other row and it is permanently unclaimable.
    const second = await claimNextDueJob("w-retired-claim-2");
    expect(second).toBeNull();
  });

  it("recoverStaleRunning never resets a retired job regardless of heartbeat staleness", async () => {
    const entryId = await seedKnowledgeEntry("retired-recover");
    const jobId = await seedPendingReconcileJob(entryId, 0);
    await retireJob(jobId);
    // Simulate a very stale heartbeat — the shape recoverStaleRunning targets
    // for `running` rows — to prove status, not staleness, is the gate.
    await execute(
      `UPDATE memory_jobs SET heartbeat_at = NOW() - interval '1 day' WHERE id = $1`,
      [jobId],
    );

    const recovered = await recoverStaleRunning(1000);
    expect(recovered.jobsReset).toBe(0);
    expect(recovered.jobsFailed).toBe(0);

    const after = await getJobById(jobId);
    expect(after!.status).toBe("retired");
  });
});
