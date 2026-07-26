/**
 * Shared seeding helpers for the S1c integration suites (memory_jobs /
 * memory_job_items / memory_decisions). NOT a test file (underscore prefix → not
 * collected by `*.int.test.ts`). S1c does NOT embed (FIX-4): candidates are
 * stored with a synthetic vector via `randVector`, so these suites exercise only
 * DB + repo logic, never the embeddings endpoint.
 */

import { createHash } from "node:crypto";

import { query } from "@vex-agent/db/client.js";
import {
  insertCandidate,
  type InsertCandidateInput,
} from "@vex-agent/db/repos/memory-candidates/index.js";
import {
  claimNextDueJob,
  enqueueConsolidateJob,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import {
  listItemsByJob,
  reserveCandidatesForJob,
} from "@vex-agent/db/repos/memory-job-items/index.js";
import { makeSession, randVector } from "../setup/fixtures.js";

export const EMBEDDING_DIM = 8;
export const EMBEDDING_MODEL = "test-model";

/** Distinct 64-char hex content hash from a seed. */
export function hex64(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function candidateInput(sessionId: string, seed: string): InsertCandidateInput {
  return {
    sessionId,
    proposedBy: "parent",
    kind: "trade_lesson",
    title: `Candidate ${seed}`,
    summary: "A short candidate summary.",
    contentMd: "Full candidate body.",
    entities: ["SOL"],
    tags: ["risk"],
    sourceRefs: { messageIds: [1] },
    evidenceRefs: [{ executionId: 5, captureItemId: 9, instrumentKey: "SOL-PERP" }],
    source: "observed",
    confidence: 0.75,
    importance: 7,
    sensitivity: "normal",
    evidenceStrength: "weak",
    retrievalVisibility: "not_consolidated",
    retrievalUntil: null,
    retainUntil: null,
    embedding: randVector(EMBEDDING_DIM, `cand-${seed}`),
    embeddingModel: EMBEDDING_MODEL,
    embeddingDim: EMBEDDING_DIM,
    contentHash: hex64(`cand-${seed}`),
    eventTime: null,
    observedAt: null,
    availableAtDecisionTime: null,
  };
}

/** Insert one pending candidate (synthetic vector) and return its uuid. */
export async function seedPendingCandidate(sessionId: string, seed: string): Promise<string> {
  const { candidate } = await insertCandidate(candidateInput(sessionId, seed));
  return candidate.id;
}

/** Insert `n` pending candidates and return their uuids (recorded_at order). */
export async function seedPendingCandidates(
  sessionId: string,
  n: number,
  prefix = "p",
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    // Serialize so recorded_at ordering is deterministic across the batch.
    ids.push(await seedPendingCandidate(sessionId, `${prefix}-${i}`));
  }
  return ids;
}

/** Seed a minimal knowledge_entries row (raw SQL) and return its serial id. */
export async function seedKnowledgeEntry(seed = "ke"): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO knowledge_entries
       (kind, title, summary, content_hash, embedding_model, embedding_dim, embedding)
     VALUES ('k', 't', 's', $1, $2, $3, $4::vector)
     RETURNING id`,
    [hex64(`ke-${seed}`), EMBEDDING_MODEL, EMBEDDING_DIM, `[${randVector(EMBEDDING_DIM, seed).join(",")}]`],
  );
  if (rows.length === 0) throw new Error("seedKnowledgeEntry: no id returned");
  return rows[0]!.id;
}

/** A candidate actively reserved by a running consolidate job. */
export interface ReservedCandidate {
  candidateId: string;
  jobId: number;
  workerId: string;
  itemId: number;
}

/**
 * Seed a candidate that is actively RESERVED by a running consolidate job — the
 * precondition `recordDecision` requires for a candidate decision (the deciding
 * job must hold the candidate). Returns the candidate / job / worker / item ids.
 */
export async function seedReservedCandidate(
  sessionId: string,
  seed: string,
): Promise<ReservedCandidate> {
  const candidateId = await seedPendingCandidate(sessionId, seed);
  await enqueueConsolidateJob();
  const workerId = `w-${seed}`;
  const job = await claimNextDueJob(workerId);
  if (!job) throw new Error("seedReservedCandidate: claim returned no job");
  await reserveCandidatesForJob(job.id, workerId, 50);
  const item = (await listItemsByJob(job.id)).find((i) => i.candidateId === candidateId);
  if (!item) throw new Error("seedReservedCandidate: candidate was not reserved");
  return { candidateId, jobId: job.id, workerId, itemId: item.id };
}

/**
 * Seed a RUNNING reconcile job for (entryId, outcomeVersion) and return its id —
 * the precondition `recordDecision` requires for a reconcile decision (jobId must
 * be THE matching reconcile job AND running).
 *
 * FIX2-SPINE C19 (Codex final-review finding 4): this used to enqueue via
 * `enqueueReconcileJob` then claim via `claimNextDueJob`. Both paths are gone
 * now — the repo's reconcile enqueue/retry exports were removed, and
 * `claimNextDueJob` only ever claims `job_kind='consolidate'` rows — so a
 * reconcile job can no longer become `running` through any exported
 * primitive. This fixture seeds the SAME end state directly via raw SQL
 * (the shape `enqueueReconcileJob` + a claim would have produced) so its one
 * consumer (`memory-decisions-crud.int.test.ts`, unedited) needs no changes.
 */
export async function seedReconcileJob(
  entryId: number,
  outcomeVersion: number,
): Promise<number> {
  const rows = await query<{ id: number }>(
    `INSERT INTO memory_jobs
       (job_kind, reconcile_entry_id, reconcile_outcome_version, status,
        locked_by, locked_at, heartbeat_at, started_at, attempt_count)
     VALUES ('reconcile', $1, $2, 'running', $3, NOW(), NOW(), NOW(), 1)
     RETURNING id`,
    [entryId, outcomeVersion, `recon-${entryId}-${outcomeVersion}`],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error("seedReconcileJob: insert returned no row");
  return id;
}

export { makeSession };
