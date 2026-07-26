/**
 * Memory-inspector DB helper — read-only window into the memory manager's
 * pipeline (memory-system S10): candidate buffer (`memory_candidates`),
 * decision audit (`memory_decisions`), and job queue (`memory_jobs` +
 * `memory_job_items`). Table names are engine-internal and never surface in
 * the DTOs.
 *
 * Mirrors `long-memory-db.ts`: own `pg.Client` per call, no
 * `@vex-agent/db/repos/*` import. The manager pipeline is global (no session
 * scope), so this is NOT app-scoped.
 *
 * SANITIZATION: the SELECTs deliberately omit
 *  - candidates: `content_md`, `source_refs`, `evidence_refs`, `outcome`,
 *    `content_hash`, all embedding columns, `session_id`, `proposed_by`,
 *    `retain_until`, `retrieval_until`;
 *  - decisions: `evidence_refs`, `decision_hash`;
 *  - jobs: `locked_by`, `locked_at`, `heartbeat_at`, and `last_error` —
 *    `memory_jobs.last_error` is untrusted free TEXT (may quote provider
 *    failures verbatim). A future slice may expose a finite vetted code
 *    allowlist instead — do NOT re-add raw `last_error` casually.
 *
 * ERROR SEMANTICS (binding): DB unreachable OR the memory tables missing
 * (undefined_table 42P01, pre-migration) both map to the redacted RETRYABLE
 * `dbUnavailable` error — NEVER `ok([])`. An empty inspector list must mean
 * "the manager has nothing here", not "the schema is not ready yet".
 */

import { Client, type ClientConfig } from "pg";
import { err, ok, type Result, type VexError } from "@shared/ipc/result.js";
import {
  LONG_MEMORY_SOURCES,
  type LongMemorySourceDto,
} from "@shared/schemas/long-memory.js";
import {
  type MemoryCandidateDto,
  type MemoryCandidateEvidenceStrengthDto,
  type MemoryCandidateRetrievalVisibilityDto,
  type MemoryCandidateSensitivityDto,
  type MemoryCandidateStatusDto,
  type MemoryDecisionActorDto,
  type MemoryDecisionDto,
  type MemoryDecisionRejectReasonDto,
  type MemoryDecisionTypeDto,
  type MemoryInspectorJobsSummaryInput,
  type MemoryInspectorListCandidatesInput,
  type MemoryInspectorListCandidatesResult,
  type MemoryInspectorListDecisionsInput,
  type MemoryInspectorListDecisionsResult,
  type MemoryJobDto,
  type MemoryJobKindDto,
  type MemoryJobStatusDto,
  type MemoryJobsSummaryDto,
  MEMORY_JOB_STATUSES,
} from "@shared/schemas/memory-inspector.js";
import { buildPoolConfig } from "./db-config.js";
import { log } from "../logger/index.js";

const CONNECT_TIMEOUT_MS = 2_000;
const QUERY_TIMEOUT_MS = 5_000;

/** Postgres `undefined_table` — memory tables not migrated yet. */
const PG_UNDEFINED_TABLE = "42P01";

function dbUnavailable(): Result<never, VexError> {
  return err({
    code: "internal.unexpected",
    domain: "memory",
    message: "Database unavailable. Verify services are running and retry.",
    retryable: true,
    userActionable: true,
    redacted: true,
  });
}

function dbError(reason: string, cause?: unknown): Result<never, VexError> {
  // Pre-migration DBs (tables missing) are "unavailable", not an internal
  // fault — the retryable/userActionable shape tells the renderer to retry
  // after services come up. Never downgraded to an empty ok result.
  if (isUndefinedTable(cause)) {
    log.warn(`[memory-inspector-db] ${reason}: memory tables missing (42P01)`);
    return dbUnavailable();
  }
  log.warn(`[memory-inspector-db] ${reason}`, cause);
  return err({
    code: "internal.unexpected",
    domain: "memory",
    message: "Unable to load memory inspector data.",
    retryable: true,
    userActionable: false,
    redacted: true,
  });
}

function isUndefinedTable(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === PG_UNDEFINED_TABLE
  );
}

async function withClient<T>(
  fn: (client: Client) => Promise<Result<T, VexError>>,
): Promise<Result<T, VexError>> {
  let cfg: Awaited<ReturnType<typeof buildPoolConfig>>;
  try {
    cfg = await buildPoolConfig();
  } catch (cause) {
    log.warn("[memory-inspector-db] buildPoolConfig threw", cause);
    return dbUnavailable();
  }
  if (cfg === null) return dbUnavailable();

  const clientConfig: ClientConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
  };
  const client = new Client(clientConfig);
  try {
    await client.connect();
  } catch (cause) {
    log.warn("[memory-inspector-db] client.connect failed", cause);
    return dbUnavailable();
  }
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (cause) {
      log.warn("[memory-inspector-db] client.end failed (non-fatal)", cause);
    }
  }
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIso(value);
}

function toNum(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/** S9 coerceSource precedent — display-tolerant: unknown provenance → null. */
function coerceSource(raw: string | null): LongMemorySourceDto | null {
  return raw !== null && (LONG_MEMORY_SOURCES as readonly string[]).includes(raw)
    ? (raw as LongMemorySourceDto)
    : null;
}

// ── Candidates ──────────────────────────────────────────────────

interface MemoryCandidateRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: string[] | null;
  readonly source: string | null;
  readonly confidence: number | string | null;
  readonly importance: number;
  readonly sensitivity: string;
  readonly evidence_strength: string;
  readonly retrieval_visibility: string;
  readonly status: string;
  readonly recorded_at: string | Date;
  readonly promoted_knowledge_id: number | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}

function mapCandidateRow(r: MemoryCandidateRow): MemoryCandidateDto {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    tags: r.tags ?? [],
    source: coerceSource(r.source),
    confidence: toNum(r.confidence),
    importance: r.importance,
    sensitivity: r.sensitivity as MemoryCandidateSensitivityDto,
    evidenceStrength: r.evidence_strength as MemoryCandidateEvidenceStrengthDto,
    retrievalVisibility:
      r.retrieval_visibility as MemoryCandidateRetrievalVisibilityDto,
    status: r.status as MemoryCandidateStatusDto,
    recordedAt: toIso(r.recorded_at),
    promotedKnowledgeId: r.promoted_knowledge_id,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}

/**
 * List memory candidates newest-first (inspector view — `recorded_at DESC`,
 * NOT the worker's FIFO order), optionally filtered by status. Bounded by
 * `input.limit` (validated + capped in the shared schema).
 */
export async function listInspectorCandidates(
  input: MemoryInspectorListCandidatesInput,
): Promise<Result<MemoryInspectorListCandidatesResult, VexError>> {
  return withClient(async (client) => {
    try {
      const params: unknown[] = [];
      let whereClause = "";
      if (input.status !== undefined) {
        params.push(input.status);
        whereClause = `WHERE status = $${params.length}`;
      }
      params.push(input.limit);
      const limitParam = params.length;
      const result = await client.query<MemoryCandidateRow>(
        `SELECT id, kind, title, summary, tags, source, confidence, importance,
                sensitivity, evidence_strength, retrieval_visibility, status,
                recorded_at, promoted_knowledge_id, created_at, updated_at
           FROM memory_candidates
           ${whereClause}
          ORDER BY recorded_at DESC, id DESC
          LIMIT $${limitParam}`,
        params,
      );
      return ok(result.rows.map(mapCandidateRow));
    } catch (cause) {
      return dbError("listInspectorCandidates query failed", cause);
    }
  });
}

// ── Decisions ───────────────────────────────────────────────────

interface MemoryDecisionRow {
  readonly id: string; // pg bigint → string (precision-safe)
  readonly candidate_id: string | null;
  readonly reconcile_entry_id: number | null;
  readonly job_id: number;
  readonly decision_version: number;
  readonly decision_type: string;
  readonly reject_reason: string | null;
  readonly promoted_knowledge_id: number | null;
  readonly supersedes_knowledge_id: number | null;
  readonly merge_target_knowledge_id: number | null;
  readonly outcome_version: number | null;
  readonly inference_provider: string | null;
  readonly inference_model: string | null;
  readonly cost_usd: number | string | null;
  readonly decided_by: string;
  readonly decided_at: string | Date;
}

function mapDecisionRow(r: MemoryDecisionRow): MemoryDecisionDto {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    reconcileEntryId: r.reconcile_entry_id,
    jobId: r.job_id,
    decisionVersion: r.decision_version,
    decisionType: r.decision_type as MemoryDecisionTypeDto,
    rejectReason: r.reject_reason as MemoryDecisionRejectReasonDto | null,
    promotedKnowledgeId: r.promoted_knowledge_id,
    supersedesKnowledgeId: r.supersedes_knowledge_id,
    mergeTargetKnowledgeId: r.merge_target_knowledge_id,
    outcomeVersion: r.outcome_version,
    inferenceProvider: r.inference_provider,
    inferenceModel: r.inference_model,
    costUsd: toNum(r.cost_usd),
    decidedBy: r.decided_by as MemoryDecisionActorDto,
    decidedAt: toIso(r.decided_at),
  };
}

/**
 * List manager decisions newest-first, optionally filtered by candidate
 * anchor and/or decision type. Bounded by `input.limit`.
 */
export async function listInspectorDecisions(
  input: MemoryInspectorListDecisionsInput,
): Promise<Result<MemoryInspectorListDecisionsResult, VexError>> {
  return withClient(async (client) => {
    try {
      const params: unknown[] = [];
      const conditions: string[] = [];
      if (input.candidateId !== undefined) {
        params.push(input.candidateId);
        conditions.push(`candidate_id = $${params.length}`);
      }
      if (input.decisionType !== undefined) {
        params.push(input.decisionType);
        conditions.push(`decision_type = $${params.length}`);
      }
      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(input.limit);
      const limitParam = params.length;
      const result = await client.query<MemoryDecisionRow>(
        `SELECT id, candidate_id, reconcile_entry_id, job_id, decision_version,
                decision_type, reject_reason, promoted_knowledge_id,
                supersedes_knowledge_id, merge_target_knowledge_id,
                outcome_version, inference_provider, inference_model, cost_usd,
                decided_by, decided_at
           FROM memory_decisions
           ${whereClause}
          ORDER BY decided_at DESC, id DESC
          LIMIT $${limitParam}`,
        params,
      );
      return ok(result.rows.map(mapDecisionRow));
    } catch (cause) {
      return dbError("listInspectorDecisions query failed", cause);
    }
  });
}

// ── Jobs summary ────────────────────────────────────────────────

interface JobStatusCountRow {
  readonly status: string;
  readonly count: number;
}

interface MemoryJobSummaryRow {
  readonly id: number;
  readonly job_kind: string;
  readonly status: string;
  readonly attempt_count: number;
  readonly max_attempts: number;
  readonly wake_pending: boolean;
  readonly next_attempt_at: string | Date | null;
  readonly cost_usd: number | string | null;
  readonly llm_call_count: number;
  readonly created_at: string | Date;
  readonly started_at: string | Date | null;
  readonly completed_at: string | Date | null;
  readonly items_done: number;
  readonly items_failed: number;
  readonly items_total: number;
}

function mapJobRow(r: MemoryJobSummaryRow): MemoryJobDto {
  return {
    id: r.id,
    jobKind: r.job_kind as MemoryJobKindDto,
    status: r.status as MemoryJobStatusDto,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    wakePending: r.wake_pending,
    nextAttemptAt: toIsoOrNull(r.next_attempt_at),
    itemsDone: r.items_done,
    itemsFailed: r.items_failed,
    itemsTotal: r.items_total,
    costUsd: toNum(r.cost_usd),
    llmCallCount: r.llm_call_count,
    createdAt: toIso(r.created_at),
    startedAt: toIsoOrNull(r.started_at),
    completedAt: toIsoOrNull(r.completed_at),
  };
}

function emptyCounts(): MemoryJobsSummaryDto["countsByStatus"] {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    permanently_failed: 0,
    retired: 0,
  };
}

/**
 * Queue snapshot: counts by status + the most recent jobs with per-job item
 * progress derived from `memory_job_items` in the SAME bounded aggregate
 * query (no N+1). Two queries on one client session. Worker-lock columns
 * (`locked_by`/`locked_at`/`heartbeat_at`) and `last_error` are never
 * selected (see module header).
 */
export async function getJobsSummary(
  input: MemoryInspectorJobsSummaryInput,
): Promise<Result<MemoryJobsSummaryDto, VexError>> {
  return withClient(async (client) => {
    try {
      const countsResult = await client.query<JobStatusCountRow>(
        `SELECT status, count(*)::int AS count
           FROM memory_jobs
          GROUP BY status`,
      );
      const countsByStatus = emptyCounts();
      for (const row of countsResult.rows) {
        if ((MEMORY_JOB_STATUSES as readonly string[]).includes(row.status)) {
          countsByStatus[row.status as MemoryJobStatusDto] = row.count;
        } else {
          // CHECK-constrained column — an unknown value means schema drift.
          // Surface it structurally instead of silently folding it away.
          log.warn(
            `[memory-inspector-db] getJobsSummary: unknown memory_jobs.status (drift), dropped from counts`,
          );
        }
      }

      const jobsResult = await client.query<MemoryJobSummaryRow>(
        `SELECT j.id, j.job_kind, j.status, j.attempt_count, j.max_attempts,
                j.wake_pending, j.next_attempt_at, j.cost_usd, j.llm_call_count,
                j.created_at, j.started_at, j.completed_at,
                COUNT(i.id) FILTER (WHERE i.item_status = 'done')::int   AS items_done,
                COUNT(i.id) FILTER (WHERE i.item_status = 'failed')::int AS items_failed,
                COUNT(i.id)::int                                         AS items_total
           FROM memory_jobs j
           LEFT JOIN memory_job_items i ON i.job_id = j.id
          GROUP BY j.id
          ORDER BY j.created_at DESC, j.id DESC
          LIMIT $1`,
        [input.recentLimit],
      );
      return ok({
        countsByStatus,
        recentJobs: jobsResult.rows.map(mapJobRow),
      });
    } catch (cause) {
      return dbError("getJobsSummary query failed", cause);
    }
  });
}
