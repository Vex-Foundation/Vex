/**
 * Integration: memory_decisions repo — append-only audit, hash idempotency,
 * idempotency_conflict, reconcile dual idempotency, anchor durability, and the
 * full set of md_* CHECK rejects (S1c).
 */

import { describe, it, expect, beforeEach } from "vitest";

import { execute, query } from "@vex-agent/db/client.js";
import {
  recordDecision,
  getDecisionsForCandidate,
  getLatestDecision,
  getDecisionsForReconcile,
  listDecisionsByType,
} from "@vex-agent/db/repos/memory-decisions/index.js";
import {
  enqueueConsolidateJob,
  claimNextDueJob,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import {
  reserveCandidatesForJob,
  markItemDone,
  listItemsByJob,
} from "@vex-agent/db/repos/memory-job-items/index.js";
import { resetDb } from "../setup/fixtures.js";
import {
  hex64,
  makeSession,
  seedKnowledgeEntry,
  seedPendingCandidate,
  seedReconcileJob,
  seedReservedCandidate,
} from "./_s1c-fixtures.js";

const GOOD_HASH = hex64("good");

describe("memory_decisions repo (integration)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("append-only + same-payload idempotency (inserted=false, one row)", async () => {
    const sid = await makeSession();
    const { candidateId: cand, jobId } = await seedReservedCandidate(sid, "idem");

    const first = await recordDecision({ decisionType: "retain", candidateId: cand, jobId });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(first.inserted).toBe(true);

    const second = await recordDecision({ decisionType: "retain", candidateId: cand, jobId });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.inserted).toBe(false);
    expect(second.decision.id).toBe(first.decision.id);

    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM memory_decisions WHERE candidate_id=$1",
      [cand],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("different payload for same (candidate, version) → idempotency_conflict", async () => {
    const sid = await makeSession();
    const { candidateId: cand, jobId } = await seedReservedCandidate(sid, "conflict");

    await recordDecision({ decisionType: "retain", candidateId: cand, jobId });
    const clash = await recordDecision({
      decisionType: "reject",
      candidateId: cand,
      jobId,
      rejectReason: "low_confidence",
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) throw new Error("unreachable");
    expect(clash.reason).toBe("idempotency_conflict");
    if (clash.reason !== "idempotency_conflict") throw new Error("unreachable");
    expect(clash.existing.decisionType).toBe("retain");

    // Still exactly one row (the conflicting decision was never inserted).
    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM memory_decisions WHERE candidate_id=$1",
      [cand],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("getDecisionsForCandidate returns ordered history (version DESC)", async () => {
    const sid = await makeSession();
    const { candidateId: cand, jobId } = await seedReservedCandidate(sid, "history");
    await recordDecision({ decisionType: "retain", candidateId: cand, jobId, decisionVersion: 0 });
    await recordDecision({ decisionType: "supersede", candidateId: cand, jobId, decisionVersion: 1 });
    await recordDecision({ decisionType: "merge", candidateId: cand, jobId, decisionVersion: 2 });

    const history = await getDecisionsForCandidate(cand);
    expect(history.map((d) => d.decisionVersion)).toEqual([2, 1, 0]);
    const latest = await getLatestDecision(cand);
    expect(latest!.decisionVersion).toBe(2);
    expect(latest!.decisionType).toBe("merge");
  });

  it("reconcile dual idempotency on (entry, outcome_version)", async () => {
    const entryId = await seedKnowledgeEntry("recon");
    // S7: the decision is stamped with the outcome_version it PRODUCED (v+1),
    // while the deciding job is keyed by the version it CONSUMED (v) — the
    // coherence check requires job.reconcile_outcome_version = decision - 1.
    const jobId = await seedReconcileJob(entryId, 1);
    const a = await recordDecision({
      decisionType: "reconcile",
      reconcileEntryId: entryId,
      outcomeVersion: 2,
      jobId,
    });
    expect(a.ok && a.inserted).toBe(true);
    const b = await recordDecision({
      decisionType: "reconcile",
      reconcileEntryId: entryId,
      outcomeVersion: 2,
      jobId,
    });
    expect(b.ok).toBe(true);
    if (!b.ok) throw new Error("unreachable");
    expect(b.inserted).toBe(false);

    const recon = await getDecisionsForReconcile(entryId);
    expect(recon).toHaveLength(1);
    expect(recon[0]!.outcomeVersion).toBe(2);
    expect(recon[0]!.candidateId).toBeNull();
  });

  it("listDecisionsByType filters by type", async () => {
    const sid = await makeSession();
    const r1 = await seedReservedCandidate(sid, "t1");
    const r2 = await seedReservedCandidate(sid, "t2");
    await recordDecision({ decisionType: "promote", candidateId: r1.candidateId, jobId: r1.jobId });
    await recordDecision({ decisionType: "retain", candidateId: r2.candidateId, jobId: r2.jobId });
    const promotes = await listDecisionsByType("promote", 10);
    expect(promotes).toHaveLength(1);
    expect(promotes[0]!.candidateId).toBe(r1.candidateId);
  });

  it("anchor durability: the decision survives deletion of its session/candidate", async () => {
    const sid = await makeSession();
    const cand = await seedPendingCandidate(sid, "durable");
    await enqueueConsolidateJob();
    const job = await claimNextDueJob("w");
    await reserveCandidatesForJob(job!.id, "w", 1);
    const item = (await listItemsByJob(job!.id))[0]!;
    const dec = await recordDecision({ decisionType: "retain", candidateId: cand, jobId: job!.id });
    if (!dec.ok) throw new Error("unreachable");
    await markItemDone(item.id, job!.id, "w", dec.decision.id);

    // Deleting the session cascades candidate → job_items, but NOT the decision.
    await execute("DELETE FROM sessions WHERE id=$1", [sid]);

    expect(
      await query<{ n: string }>(
        "SELECT count(*)::text AS n FROM memory_candidates WHERE id=$1",
        [cand],
      ),
    ).toEqual([{ n: "0" }]);
    const survived = await getDecisionsForCandidate(cand);
    expect(survived).toHaveLength(1);
    expect(survived[0]!.id).toBe(dec.decision.id);
  });

  it("outcome pointer (promoted_knowledge_id) is SET NULL on entry delete", async () => {
    const sid = await makeSession();
    const { candidateId: cand, jobId } = await seedReservedCandidate(sid, "setnull");
    const keId = await seedKnowledgeEntry("promoted");
    await recordDecision({
      decisionType: "promote",
      candidateId: cand,
      jobId,
      promotedKnowledgeId: keId,
    });
    expect((await getLatestDecision(cand))!.promotedKnowledgeId).toBe(keId);
    await execute("DELETE FROM knowledge_entries WHERE id=$1", [keId]);
    expect((await getLatestDecision(cand))!.promotedKnowledgeId).toBeNull();
  });

  it("refuses a candidate decision when the job never reserved the candidate (anchor_incoherent)", async () => {
    const sid = await makeSession();
    const cand = await seedPendingCandidate(sid, "incoherent");
    await enqueueConsolidateJob();
    const job = await claimNextDueJob("w"); // claimed, but did NOT reserve `cand`
    const res = await recordDecision({ decisionType: "retain", candidateId: cand, jobId: job!.id });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("anchor_incoherent");
    expect(
      await query<{ n: string }>(
        "SELECT count(*)::text AS n FROM memory_decisions WHERE candidate_id=$1",
        [cand],
      ),
    ).toEqual([{ n: "0" }]);
  });

  it("refuses a reconcile decision whose jobId is not the matching reconcile job (anchor_incoherent)", async () => {
    const entryId = await seedKnowledgeEntry("recon-incoherent");
    await enqueueConsolidateJob();
    const wrongJob = await claimNextDueJob("w"); // a consolidate job, not THE reconcile job
    const res = await recordDecision({
      decisionType: "reconcile",
      reconcileEntryId: entryId,
      outcomeVersion: 1,
      jobId: wrongJob!.id,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.reason).toBe("anchor_incoherent");
  });

  describe("md_* CHECK enforcement (raw inserts)", () => {
    async function expectReject(sql: string, params: unknown[], pattern: RegExp): Promise<void> {
      await expect(execute(sql, params)).rejects.toThrow(pattern);
    }

    it("md_anchor_xor: both anchors set is rejected", async () => {
      const entryId = await seedKnowledgeEntry("xor-both");
      const sid = await makeSession();
      const cand = await seedPendingCandidate(sid, "xor-both");
      await expectReject(
        `INSERT INTO memory_decisions (candidate_id, reconcile_entry_id, job_id, decision_type, decision_hash, outcome_version)
         VALUES ($1, $2, 1, 'reconcile', $3, 0)`,
        [cand, entryId, GOOD_HASH],
        /md_anchor_xor/,
      );
    });

    it("md_anchor_xor: neither anchor set is rejected", async () => {
      await expectReject(
        `INSERT INTO memory_decisions (job_id, decision_type, decision_hash) VALUES (1, 'retain', $1)`,
        [GOOD_HASH],
        /md_anchor_xor/,
      );
    });

    it("md_reconcile_type: reconcile type on a candidate anchor is rejected", async () => {
      const sid = await makeSession();
      const cand = await seedPendingCandidate(sid, "rtype");
      await expectReject(
        `INSERT INTO memory_decisions (candidate_id, job_id, decision_type, decision_hash)
         VALUES ($1, 1, 'reconcile', $2)`,
        [cand, GOOD_HASH],
        /md_reconcile_type/,
      );
    });

    it("md_reconcile_fields: a candidate decision carrying outcome_version is rejected", async () => {
      const sid = await makeSession();
      const cand = await seedPendingCandidate(sid, "rfields");
      await expectReject(
        `INSERT INTO memory_decisions (candidate_id, job_id, decision_type, decision_hash, outcome_version)
         VALUES ($1, 1, 'promote', $2, 3)`,
        [cand, GOOD_HASH],
        /md_reconcile_fields/,
      );
    });

    it("md_reconcile_fields: a reconcile decision with NULL outcome_version is rejected", async () => {
      const entryId = await seedKnowledgeEntry("rnull");
      await expectReject(
        `INSERT INTO memory_decisions (reconcile_entry_id, job_id, decision_type, decision_hash)
         VALUES ($1, 1, 'reconcile', $2)`,
        [entryId, GOOD_HASH],
        /md_reconcile_fields/,
      );
    });

    it("md_reject_reason_scope: reject without a reason / non-reject with a reason", async () => {
      const sid = await makeSession();
      const cand = await seedPendingCandidate(sid, "scope");
      await expectReject(
        `INSERT INTO memory_decisions (candidate_id, job_id, decision_type, decision_hash)
         VALUES ($1, 1, 'reject', $2)`,
        [cand, GOOD_HASH],
        /md_reject_reason_scope/,
      );
      const cand2 = await seedPendingCandidate(sid, "scope2");
      await expectReject(
        `INSERT INTO memory_decisions (candidate_id, job_id, decision_type, decision_hash, reject_reason)
         VALUES ($1, 1, 'retain', $2, 'policy')`,
        [cand2, GOOD_HASH],
        /md_reject_reason_scope/,
      );
    });

    it("md_decision_hash_hex: a malformed hash is rejected", async () => {
      const sid = await makeSession();
      const cand = await seedPendingCandidate(sid, "hash");
      await expectReject(
        `INSERT INTO memory_decisions (candidate_id, job_id, decision_type, decision_hash)
         VALUES ($1, 1, 'retain', 'NOT-A-VALID-HASH')`,
        [cand],
        /md_decision_hash_hex/,
      );
    });
  });
});
