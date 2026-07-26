/**
 * Integration: memory_jobs repo — durable queue FSM, wake_pending consumption
 * on markCompleted, crash-recovery flag preservation (gate R1), derived
 * progress, atomic stale recovery, CHECK/uniqueness enforcement (S1c + S7).
 *
 * FIX2-SPINE C19 (Codex final-review finding 4): the repo's `enqueueReconcileJob`
 * / `resetReconcileJob` exports are removed (the async `reconcile` job kind is
 * retired end-to-end — see `db/repos/memory-jobs/crud.ts`'s file header). Every
 * test that existed ONLY to pin those two functions' own behavior (RE-ARM,
 * wake_pending flagging, permanently_failed protection, race-safety) is removed
 * with them — there is no longer a subject under test (repo convention: a
 * removed subsystem's test bodies are deleted, not left skipped, per
 * `src/__tests__/SKIPPED.md`). The wake_pending tests below that exercise
 * GENERIC, still-live logic (`markCompleted`'s consumption, `recoverStaleRunning`'s
 * preservation) are kept, reseeded via raw SQL instead of the removed enqueue
 * function — seeding mechanics changed, assertions did not. The CHECK/uniqueness
 * tests are DB-level (raw SQL against constraints that still exist for
 * historical/retired rows) and are unaffected by the repo-function removal
 * beyond the same raw-SQL seeding swap.
 *
 * Runs against the ephemeral pgvector container from `setup/globalSetup.ts`.
 * S1c does NOT embed — candidates use synthetic vectors (_s1c-fixtures).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import {
  enqueueConsolidateJob,
  claimNextDueJob,
  markFailed,
  markCompleted,
  bumpJobInference,
  getJobProgress,
  getJobById,
  listJobsByStatus,
  recoverStaleRunning,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import {
  reserveCandidatesForJob,
  markItemProcessing,
  markItemFailed,
  releaseItemsForJob,
  listItemsByJob,
} from "@vex-agent/db/repos/memory-job-items/index.js";
import { resetDb } from "../setup/fixtures.js";
import {
  makeSession,
  seedKnowledgeEntry,
  seedPendingCandidates,
} from "./_s1c-fixtures.js";

/**
 * Seed a pending reconcile row directly (raw SQL) — the same shape the
 * now-removed `enqueueReconcileJob` used to insert.
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

describe("memory_jobs repo (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("enqueueConsolidateJob inserts a fresh pending consolidate job each call", async () => {
    const a = await enqueueConsolidateJob();
    const b = await enqueueConsolidateJob();
    expect(a.jobKind).toBe("consolidate");
    expect(a.status).toBe("pending");
    expect(a.reconcileEntryId).toBeNull();
    expect(a.reconcileOutcomeVersion).toBeNull();
    expect(a.attemptCount).toBe(0);
    expect(a.llmCallCount).toBe(0);
    expect(b.id).not.toBe(a.id); // no idempotency key — always a new row
  });

  it("claim race: two parallel claims of one pending job → exactly one wins", async () => {
    await enqueueConsolidateJob();
    const [a, b] = await Promise.all([
      claimNextDueJob("worker-A"),
      claimNextDueJob("worker-B"),
    ]);
    const claimed = [a, b].filter((j) => j !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("running");
    expect(claimed[0]!.attemptCount).toBe(1); // attempt incremented at claim
  });

  it("retry/permanent: markFailed retries with backoff then permanently_failed", async () => {
    await enqueueConsolidateJob();

    const j1 = await claimNextDueJob("w");
    expect(j1!.attemptCount).toBe(1);
    const r1 = await markFailed(j1!.id, "w", "transient_error", 0);
    expect(r1).toEqual({ ok: true, terminal: false });
    expect((await getJobById(j1!.id))!.status).toBe("failed");

    const j2 = await claimNextDueJob("w");
    expect(j2!.id).toBe(j1!.id);
    expect(j2!.attemptCount).toBe(2);
    await markFailed(j2!.id, "w", "transient_error", 0);

    const j3 = await claimNextDueJob("w");
    expect(j3!.attemptCount).toBe(3);
    const r3 = await markFailed(j3!.id, "w", "transient_error", 0);
    expect(r3).toEqual({ ok: true, terminal: true });
    expect((await getJobById(j1!.id))!.status).toBe("permanently_failed");

    // Exhausted (attempt_count >= max_attempts) → no longer claimable.
    expect(await claimNextDueJob("w")).toBeNull();
  });

  it("markFailed / markCompleted are owner-checked", async () => {
    await enqueueConsolidateJob();
    const job = await claimNextDueJob("owner");
    // Wrong worker cannot fail or complete the job.
    expect(await markFailed(job!.id, "intruder", "x", 0)).toEqual({ ok: false, terminal: false });
    expect(await markCompleted(job!.id, "intruder")).toBe(false);
    // Owner can complete it.
    expect(await markCompleted(job!.id, "owner")).toBe(true);
    expect((await getJobById(job!.id))!.status).toBe("completed");
  });

  // FIX2-SPINE C19 (Codex final-review finding 4): the following tests used
  // to exercise `enqueueReconcileJob`'s own RE-ARM/no-op/race-safety CASE
  // logic and `resetReconcileJob`'s own permanently_failed-only reset — both
  // functions are removed (see file header), so those tests are removed with
  // them. `markCompleted`'s wake_pending consumption and
  // `recoverStaleRunning`'s wake_pending preservation are GENERIC, still-live
  // logic (wake_pending remains a real column both functions handle
  // unconditionally); the two tests below keep pinning that behavior, reseeded
  // via raw SQL to set up a `running` job carrying `wake_pending=true` instead
  // of going through the removed enqueue function.

  it("markCompleted CONSUMES a wake_pending flag into one more pending pass", async () => {
    const job = await enqueueConsolidateJob();
    const claimed = await claimNextDueJob("w");
    expect(claimed!.id).toBe(job.id);

    // Raw-SQL wake signal (historically only ever raised by
    // enqueueReconcileJob's conflict path on a running row).
    await execute("UPDATE memory_jobs SET wake_pending = true WHERE id = $1", [job.id]);

    // Completion consumes the flag: pending + attempt 0, NOT completed.
    expect(await markCompleted(job.id, "w")).toBe(true);
    const after = await getJobById(job.id);
    expect(after!.status).toBe("pending");
    expect(after!.attemptCount).toBe(0);
    expect(after!.completedAt).toBeNull();
    expect(after!.wakePending).toBe(false);

    // The second pass runs and completes normally (flag already consumed).
    const second = await claimNextDueJob("w");
    expect(second!.id).toBe(job.id);
    expect(await markCompleted(second!.id, "w")).toBe(true);
    expect((await getJobById(job.id))!.status).toBe("completed");
  });

  it("recoverStaleRunning PRESERVES wake_pending (S7 gate R1 — the signal survives a worker crash)", async () => {
    const job = await enqueueConsolidateJob();
    await claimNextDueJob("w");
    // Raw-SQL wake signal on the now-running job (see test above).
    await execute("UPDATE memory_jobs SET wake_pending = true WHERE id = $1", [job.id]);
    expect((await getJobById(job.id))!.wakePending).toBe(true);

    await execute(
      "UPDATE memory_jobs SET heartbeat_at = NOW() - interval '10 minutes' WHERE id=$1",
      [job.id],
    );
    const recovered = await recoverStaleRunning(1000);
    expect(recovered.jobsReset).toBe(1);

    const after = await getJobById(job.id);
    expect(after!.status).toBe("pending");
    expect(after!.wakePending).toBe(true); // NOT cleaned up by recovery
  });

  it("bumpJobInference accumulates only llm_call_count + cost_usd", async () => {
    const job = await enqueueConsolidateJob();
    await bumpJobInference(job.id, { llmCalls: 1, costUsd: 0.5 });
    const after = await bumpJobInference(job.id, { llmCalls: 2, costUsd: 0.25 });
    expect(after!.llmCallCount).toBe(3);
    expect(after!.costUsd).toBeCloseTo(0.75, 4);
  });

  it("getJobProgress is DERIVED and never drifts on reserve→release→revive", async () => {
    const sid = await makeSession();
    await seedPendingCandidates(sid, 3, "prog");
    await enqueueConsolidateJob();
    const job = await claimNextDueJob("w");

    const r1 = await reserveCandidatesForJob(job!.id, "w", 10);
    expect(r1).toHaveLength(3);
    expect(await getJobProgress(job!.id)).toMatchObject({ reserved: 3, total: 3 });

    await releaseItemsForJob(job!.id);
    expect(await getJobProgress(job!.id)).toMatchObject({ released: 3, reserved: 0, total: 3 });

    // Revive own released items — still 3 ITEMS total, not 6 (no stored counter to drift).
    const r2 = await reserveCandidatesForJob(job!.id, "w", 10);
    expect(r2).toHaveLength(3);
    expect(await getJobProgress(job!.id)).toMatchObject({ reserved: 3, released: 0, total: 3 });
  });

  it("recoverStaleRunning resets a stale job to pending AND releases its reserved items in one transaction", async () => {
    const sid = await makeSession();
    const candIds = await seedPendingCandidates(sid, 2, "stale");
    await enqueueConsolidateJob();
    const job = await claimNextDueJob("w");
    await reserveCandidatesForJob(job!.id, "w", 10);
    await markItemProcessing(
      (await listItemsByJob(job!.id))[0]!.id,
      job!.id,
      "w",
    );

    // Make the heartbeat stale.
    await execute("UPDATE memory_jobs SET heartbeat_at = NOW() - interval '10 minutes' WHERE id=$1", [
      job!.id,
    ]);

    const recovered = await recoverStaleRunning(1000);
    expect(recovered.jobsReset).toBe(1);
    expect(recovered.itemsReleased).toBe(2);

    expect((await getJobById(job!.id))!.status).toBe("pending");
    const items = await listItemsByJob(job!.id);
    expect(items.every((i) => i.itemStatus === "released")).toBe(true);

    // Candidates re-enter the pool. The recovered job carries a backoff
    // (next_attempt_at in the future), so claim a FRESH job — it reserves both
    // released candidates (still pending, no active hold).
    const fresh = await enqueueConsolidateJob();
    const job2 = await claimNextDueJob("w");
    expect(job2!.id).toBe(fresh.id);
    const r = await reserveCandidatesForJob(job2!.id, "w", 10);
    expect(new Set(r)).toEqual(new Set(candIds));
  });

  it("recoverStaleRunning fails a stale FINAL-attempt job instead of stranding it as unclaimable pending", async () => {
    const job = await enqueueConsolidateJob();
    // A job that went stale on its LAST attempt: running, attempt_count == max_attempts.
    // Resetting it to pending would make it unclaimable (claim needs attempt < max) AND
    // unresettable (no exported primitive resets an exhausted row) — i.e. stranded.
    await execute(
      `UPDATE memory_jobs SET status='running', attempt_count=max_attempts, locked_by='w',
         heartbeat_at = NOW() - interval '10 minutes' WHERE id=$1`,
      [job.id],
    );
    const recovered = await recoverStaleRunning(1000);
    expect(recovered.jobsFailed).toBe(1);
    expect(recovered.jobsReset).toBe(0);
    expect((await getJobById(job.id))!.status).toBe("permanently_failed");
  });

  it("listJobsByStatus filters and orders by created_at", async () => {
    await enqueueConsolidateJob();
    await enqueueConsolidateJob();
    const pending = await listJobsByStatus("pending", 10);
    expect(pending).toHaveLength(2);
    expect(pending.every((j) => j.status === "pending")).toBe(true);
    expect(await listJobsByStatus("pending", 0)).toEqual([]);
  });

  describe("CHECK / uniqueness enforcement", () => {
    it("rejects a consolidate job carrying reconcile fields (mj_reconcile_fields)", async () => {
      const entryId = await seedKnowledgeEntry("badconsolidate");
      await expect(
        execute(
          "INSERT INTO memory_jobs (job_kind, reconcile_entry_id) VALUES ('consolidate', $1)",
          [entryId],
        ),
      ).rejects.toThrow(/mj_reconcile_fields/);
    });

    it("rejects a reconcile job missing an outcome_version (mj_reconcile_fields)", async () => {
      const entryId = await seedKnowledgeEntry("badreconcile");
      await expect(
        execute(
          "INSERT INTO memory_jobs (job_kind, reconcile_entry_id) VALUES ('reconcile', $1)",
          [entryId],
        ),
      ).rejects.toThrow(/mj_reconcile_fields/);
    });

    it("enforces uniq_mj_reconcile across all statuses (raw second insert)", async () => {
      const entryId = await seedKnowledgeEntry("uniqr");
      await seedPendingReconcileJob(entryId, 5);
      await expect(
        execute(
          "INSERT INTO memory_jobs (job_kind, reconcile_entry_id, reconcile_outcome_version, status) VALUES ('reconcile', $1, 5, 'completed')",
          [entryId],
        ),
      ).rejects.toThrow(/uniq_mj_reconcile/);
    });

    it("cascades reconcile jobs when the knowledge entry is deleted", async () => {
      const entryId = await seedKnowledgeEntry("cascade");
      const jobId = await seedPendingReconcileJob(entryId, 0);
      await execute("DELETE FROM knowledge_entries WHERE id=$1", [entryId]);
      expect(await getJobById(jobId)).toBeNull();
    });
  });
});
