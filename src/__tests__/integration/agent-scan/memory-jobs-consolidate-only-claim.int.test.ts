/**
 * `claimNextDueJob` — consolidate-only claiming (FIX2-W0, Codex final-review
 * round 1 finding 4, bound in `agents_dm/agent-scan-factory.md`
 * "Coordinator addendum 2" as C19).
 *
 * The plan retires the async `reconcile` job kind entirely (memory teardown);
 * `claimNextDueJob` must therefore claim ONLY `job_kind='consolidate'` rows
 * going forward, even when an older due `reconcile` row still exists in an
 * already-installed database (migration 044 terminalizes queued/running
 * reconcile rows, but a `pending` one predating that terminalization, or one
 * inserted by a stale caller before the export removal, must still never be
 * claimable). EXPECTED RED today: `claimNextDueJob`'s SELECT has no
 * `job_kind` predicate at all — it claims whichever due row is oldest,
 * regardless of kind.
 *
 * `enqueueReconcileJob`/`resetReconcileJob` were REMOVED from
 * `db/repos/memory-jobs/crud.ts` per C19 — this suite seeds a `reconcile` row
 * directly via raw SQL instead of calling a (now nonexistent) enqueue helper.
 * Imports go straight to `crud.js` rather than the `memory-jobs/index.js`
 * barrel, which at the time of writing still re-exports the removed names
 * (a transient FIX-SPINE mid-edit inconsistency, not this suite's concern to
 * fix) and would otherwise fail to load.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { execute, query, queryOne } from "@vex-agent/db/client.js";
import { enqueueConsolidateJob, claimNextDueJob } from "@vex-agent/db/repos/memory-jobs/crud.js";

const seededJobIds: number[] = [];

/** Seed a due, claimable `reconcile` row directly (the enqueue helper was removed — C19).
 * `mj_reconcile_fields` CHECK requires reconcile_entry_id + reconcile_outcome_version,
 * so a minimal knowledge_entries anchor row is seeded first (zero-vector embedding). */
const seededEntryIds: number[] = [];
async function seedDueReconcileJob(): Promise<number> {
  const zeroVec = `[${Array(768).fill(0).join(",")}]`;
  const entry = await queryOne<{ id: number }>(
    `INSERT INTO knowledge_entries (kind, title, summary, content_hash, embedding_model, embedding_dim, embedding)
     VALUES ('test_fixture', 't', 's', $1, 'fixture-model', 768, $2::vector)
     RETURNING id`,
    [`c19-fixture-${randomUUID()}`, zeroVec],
  );
  if (!entry) throw new Error("memory-jobs fixture: knowledge_entries insert returned no row");
  seededEntryIds.push(entry.id);
  const row = await queryOne<{ id: number }>(
    `INSERT INTO memory_jobs (job_kind, status, next_attempt_at, reconcile_entry_id, reconcile_outcome_version)
     VALUES ('reconcile', 'pending', NOW(), $1, 1)
     RETURNING id`,
    [entry.id],
  );
  if (!row) throw new Error("memory-jobs fixture: reconcile insert returned no row");
  seededJobIds.push(row.id);
  return row.id;
}

afterEach(async () => {
  if (seededJobIds.length > 0) {
    const ids = seededJobIds.splice(0, seededJobIds.length);
    await execute(`DELETE FROM memory_jobs WHERE id = ANY($1::int[])`, [ids]);
  }
  if (seededEntryIds.length > 0) {
    const entryIds = seededEntryIds.splice(0, seededEntryIds.length);
    await execute(`DELETE FROM knowledge_entries WHERE id = ANY($1::int[])`, [entryIds]);
  }
});

describe("claimNextDueJob — consolidate-only claim (C19)", () => {
  it("skips an older DUE reconcile row and claims the consolidate job instead", async () => {
    // The reconcile row is seeded FIRST (older created_at, so a kind-blind
    // ORDER BY created_at ASC would pick it before the consolidate job).
    const reconcileJobId = await seedDueReconcileJob();
    const consolidate = await enqueueConsolidateJob();
    seededJobIds.push(consolidate.id);

    const claimed = await claimNextDueJob(`w0-fix2-${randomUUID()}`);

    expect(claimed).not.toBeNull();
    expect(claimed?.jobKind).toBe("consolidate");
    expect(claimed?.id).toBe(consolidate.id);
    expect(claimed?.id).not.toBe(reconcileJobId);

    // The reconcile row must remain untouched (never claimed, never
    // transitioned to 'running') — it is not claimable at all, not merely
    // deprioritized.
    const stillPending = await query<{ status: string; locked_by: string | null }>(
      `SELECT status, locked_by FROM memory_jobs WHERE id = $1`,
      [reconcileJobId],
    );
    expect(stillPending[0]?.status).toBe("pending");
    expect(stillPending[0]?.locked_by).toBeNull();
  });

  it("returns null when only a due reconcile row exists (no consolidate job to claim)", async () => {
    const reconcileJobId = await seedDueReconcileJob();

    const claimed = await claimNextDueJob(`w0-fix2-${randomUUID()}`);

    expect(claimed).toBeNull();
    const stillPending = await query<{ status: string }>(
      `SELECT status FROM memory_jobs WHERE id = $1`,
      [reconcileJobId],
    );
    expect(stillPending[0]?.status).toBe("pending");
  });
});
