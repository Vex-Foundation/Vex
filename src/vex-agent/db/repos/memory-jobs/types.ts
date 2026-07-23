/**
 * memory_jobs repo — types + row mapper + column list.
 *
 * Durable batch/sweep queue (compact_jobs precedent): `pending → running →
 * completed | failed → permanently_failed`. The async memory_manager (S4)
 * claims a job, reserves candidates via memory_job_items, and appends decisions.
 * This module is the storage substrate only — no worker loop / LLM / promote().
 *
 * Per-batch progress (reserved/done/failed counts) is DERIVED from
 * memory_job_items (getJobProgress), never stored (R4-MF2). Only the true
 * accumulators `llmCallCount` / `costUsd` live on the row.
 *
 * Pure-data module: interfaces + pg-row → domain conversion. The bounded-vocab
 * `jobKind` / `status` enums are owned by `memory/schema/memory-job-enums.ts`;
 * mapRow casts the DB-CHECK-guaranteed strings to those enums (sibling-repo
 * precedent).
 */

import type {
  MemoryJobKind,
  MemoryJobStatus,
} from "@vex-agent/memory/schema/memory-job-enums.js";

export type {
  MemoryJobKind,
  MemoryJobStatus,
} from "@vex-agent/memory/schema/memory-job-enums.js";

// ── Pg row shape (snake_case) ───────────────────────────────────
export interface MemoryJobRow {
  id: number;
  job_kind: string;
  status: string;
  reconcile_entry_id: number | null;
  reconcile_outcome_version: number | null;
  wake_pending: boolean;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string;
  locked_at: string | null;
  locked_by: string | null;
  heartbeat_at: string | null;
  last_error: string | null;
  inference_provider: string | null;
  inference_model: string | null;
  inference_completed_at: string | null;
  cost_usd: string | null; // pg numeric → string in driver
  llm_call_count: number;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

// ── Domain shape (camelCase) ────────────────────────────────────
export interface MemoryJob {
  id: number;
  jobKind: MemoryJobKind;
  status: MemoryJobStatus;
  /** knowledge_entries.id this reconcile job re-derives, or null for consolidate. */
  reconcileEntryId: number | null;
  /** knowledge_entries.outcome_version this reconcile job targets, or null. */
  reconcileOutcomeVersion: number | null;
  /**
   * S7 D-REARM — a ledger wake arrived WHILE this reconcile job was `running`
   * (the in-flight pass read the ledger before the wake's write). Consumed by
   * markCompleted: completed → pending + attempt 0 + flag false, so the job runs
   * one more pass against the post-wake ledger. Always false on consolidate rows.
   */
  wakePending: boolean;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  heartbeatAt: string | null;
  lastError: string | null;
  inferenceProvider: string | null;
  inferenceModel: string | null;
  inferenceCompletedAt: string | null;
  /** Accumulated USD cost across the job's LLM calls (bumpJobInference). */
  costUsd: number | null;
  /** Accumulated LLM call count (bumpJobInference). */
  llmCallCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Derived per-batch progress (R4-MF2) — counts of memory_job_items by
 * `item_status`, never stored on the job row. `total` is the sum.
 */
export interface JobProgress {
  reserved: number;
  processing: number;
  done: number;
  failed: number;
  released: number;
  total: number;
}

export function mapRow(r: MemoryJobRow): MemoryJob {
  return {
    id: r.id,
    jobKind: r.job_kind as MemoryJobKind,
    status: r.status as MemoryJobStatus,
    reconcileEntryId: r.reconcile_entry_id,
    reconcileOutcomeVersion: r.reconcile_outcome_version,
    wakePending: r.wake_pending,
    attemptCount: r.attempt_count,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    heartbeatAt: r.heartbeat_at,
    lastError: r.last_error,
    inferenceProvider: r.inference_provider,
    inferenceModel: r.inference_model,
    inferenceCompletedAt: r.inference_completed_at,
    costUsd: r.cost_usd === null ? null : Number.parseFloat(r.cost_usd),
    llmCallCount: r.llm_call_count,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
  };
}

// ── Column list (single source of truth for reads) ──────────────
export const JOB_COLUMNS = `
  id, job_kind, status, reconcile_entry_id, reconcile_outcome_version, wake_pending,
  attempt_count, max_attempts, next_attempt_at,
  locked_at, locked_by, heartbeat_at, last_error,
  inference_provider, inference_model, inference_completed_at,
  cost_usd, llm_call_count,
  created_at, started_at, completed_at
`;
