/**
 * Compaction-preparations repo — statuses, domain/row types, boundary-validated
 * row mapper, and the shared column list.
 *
 * The status unions here are the TypeScript half of a lockstep contract with the
 * SQL CHECK constraints in `058_compaction_preparations.sql`. They are pinned by
 * `compaction-preparations-status-lockstep.test.ts`, which parses the migration:
 * a TS-ahead-of-SQL drift makes a writer name a status Postgres rejects, and an
 * SQL-ahead-of-TS drift makes `mapRow` cast a string into a union that does not
 * contain it. Neither is catchable at runtime.
 */

import { z } from "zod";

import { FrozenChunksOutputSchema, type FrozenChunksOutput } from "./frozen-output-schema.js";

// ── Status vocabularies ──────────────────────────────────────────

export type PreparationStatus =
  | "preparing"
  | "summary_ready"
  | "apply_requested"
  | "applying"
  | "applied"
  | "failed"
  | "superseded";

export const PREPARATION_STATUSES: readonly PreparationStatus[] = [
  "preparing",
  "summary_ready",
  "apply_requested",
  "applying",
  "applied",
  "failed",
  "superseded",
] as const;

/** Row statuses that occupy the one-live-per-session partial unique index. */
export const LIVE_PREPARATION_STATUSES: readonly PreparationStatus[] = [
  "preparing",
  "summary_ready",
  "apply_requested",
  "applying",
] as const;

/**
 * Branch-A statuses. Branch B adds `frozen` — see `ChunksBranchStatus`. The
 * union shared with the desktop app (EOS's surface DTO) is
 * `BranchStatus`, which is the SUPERSET, because the renderer receives both
 * branches through one enum and must be able to name `frozen` and
 * `permanently_failed`.
 */
export type SummaryBranchStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "permanently_failed";

export type ChunksBranchStatus = SummaryBranchStatus | "frozen";

export type BranchStatus = ChunksBranchStatus;

export const SUMMARY_BRANCH_STATUSES: readonly SummaryBranchStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "permanently_failed",
] as const;

export const CHUNKS_BRANCH_STATUSES: readonly ChunksBranchStatus[] = [
  "pending",
  "running",
  "frozen",
  "succeeded",
  "failed",
  "permanently_failed",
] as const;

/**
 * Frozen apply-source vocabulary. `apply_requested` is a STATUS, never a
 * source — the source records WHO asked, and the forced critical path stamps
 * `forced_critical` even when it consumes a row that a user queued.
 */
export type ApplySource =
  | "ui_button"
  | "agent_tool"
  | "auto_full_autonomous"
  | "forced_critical";

export const APPLY_SOURCES: readonly ApplySource[] = [
  "ui_button",
  "agent_tool",
  "auto_full_autonomous",
  "forced_critical",
] as const;

/** Which of the two independent branch lease column sets a call addresses. */
export type Branch = "summary" | "chunks";

// ── Domain type ──────────────────────────────────────────────────

export interface CompactionPreparation {
  id: number;
  sessionId: string;
  status: PreparationStatus;

  watermarkMessageId: number;
  baseCheckpointGeneration: number;
  targetCheckpointGeneration: number;
  frozenSessionSummary: string | null;
  /** NULL only after retention pruned it — see `corpusPrunedAt`. */
  corpusText: string | null;
  corpusSha256: string;
  corpusFormatVersion: number;
  corpusMessageCount: number;
  corpusBytes: number;
  corpusRedactionHard: number;
  corpusRedactionMask: number;
  corpusPrunedAt: string | null;

  summaryStatus: SummaryBranchStatus;
  summaryAttemptCount: number;
  summaryMaxAttempts: number;
  summaryNextAttemptAt: string;
  summaryLockedAt: string | null;
  summaryLockedBy: string | null;
  summaryHeartbeatAt: string | null;
  summaryLastError: string | null;
  summaryOutput: string | null;
  summaryPromptVersion: string | null;
  summaryProvider: string | null;
  summaryModel: string | null;
  summaryCompletedAt: string | null;
  summaryCostUsd: number | null;

  chunksStatus: ChunksBranchStatus;
  chunksAttemptCount: number;
  chunksMaxAttempts: number;
  chunksNextAttemptAt: string;
  chunksLockedAt: string | null;
  chunksLockedBy: string | null;
  chunksHeartbeatAt: string | null;
  chunksLastError: string | null;
  chunksFrozenOutput: FrozenChunksOutput | null;
  chunksFrozenOutputSha256: string | null;
  chunksFrozenAt: string | null;
  /** Discarded while BUILDING the snapshot — see the migration's phase note. */
  chunksRejectedByExclusionAtFreeze: number;
  chunksRejectedByRedactionAtFreeze: number;
  /** INSERT-phase outcome; nothing is rejected at insert. */
  chunksInserted: number;
  chunksDeduped: number;
  chunksLandedAfterSupersession: boolean;
  chunksProvider: string | null;
  chunksModel: string | null;
  chunksCompletedAt: string | null;
  chunksCostUsd: number | null;

  applySource: ApplySource | null;
  applyRequestedAt: string | null;
  applyStartedAt: string | null;
  applyLockedBy: string | null;
  applyHeartbeatAt: string | null;
  applyAttemptCount: number;
  moneyGateBypassReasons: string[] | null;
  appliedGeneration: number | null;
  appliedAt: string | null;
  supersededById: number | null;
  lastError: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** Fork-time input. Everything else is defaulted by the schema. */
export interface NewCompactionPreparation {
  sessionId: string;
  watermarkMessageId: number;
  baseCheckpointGeneration: number;
  targetCheckpointGeneration: number;
  frozenSessionSummary: string | null;
  corpusText: string;
  /** Computed by the corpus builder over `corpusText`; stored, never recomputed here. */
  corpusSha256: string;
  corpusFormatVersion: number;
  corpusMessageCount: number;
  corpusBytes: number;
  corpusRedactionHard: number;
  corpusRedactionMask: number;
}

// ── Row type ─────────────────────────────────────────────────────

export interface CompactionPreparationRow {
  id: number;
  session_id: string;
  status: string;
  watermark_message_id: number;
  base_checkpoint_generation: number;
  target_checkpoint_generation: number;
  frozen_session_summary: string | null;
  corpus_text: string | null;
  corpus_sha256: string;
  corpus_format_version: number;
  corpus_message_count: number;
  corpus_bytes: number;
  corpus_redaction_hard: number;
  corpus_redaction_mask: number;
  corpus_pruned_at: string | null;
  summary_status: string;
  summary_attempt_count: number;
  summary_max_attempts: number;
  summary_next_attempt_at: string;
  summary_locked_at: string | null;
  summary_locked_by: string | null;
  summary_heartbeat_at: string | null;
  summary_last_error: string | null;
  summary_output: string | null;
  summary_prompt_version: string | null;
  summary_provider: string | null;
  summary_model: string | null;
  summary_completed_at: string | null;
  summary_cost_usd: string | null; // pg numeric → string in the driver
  chunks_status: string;
  chunks_attempt_count: number;
  chunks_max_attempts: number;
  chunks_next_attempt_at: string;
  chunks_locked_at: string | null;
  chunks_locked_by: string | null;
  chunks_heartbeat_at: string | null;
  chunks_last_error: string | null;
  chunks_frozen_output: unknown;
  chunks_frozen_output_sha256: string | null;
  chunks_frozen_at: string | null;
  chunks_rejected_by_exclusion_at_freeze: number;
  chunks_rejected_by_redaction_at_freeze: number;
  chunks_inserted: number;
  chunks_deduped: number;
  chunks_landed_after_supersession: boolean;
  chunks_provider: string | null;
  chunks_model: string | null;
  chunks_completed_at: string | null;
  chunks_cost_usd: string | null; // pg numeric → string in the driver
  apply_source: string | null;
  apply_requested_at: string | null;
  apply_started_at: string | null;
  apply_locked_by: string | null;
  apply_heartbeat_at: string | null;
  apply_attempt_count: number;
  money_gate_bypass_reasons: unknown;
  applied_generation: number | null;
  applied_at: string | null;
  superseded_by_id: number | null;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

// ── Boundary validation ──────────────────────────────────────────

/**
 * DB rows are untrusted input (rules/03). The two JSONB columns are parsed, not
 * cast: a snapshot written by a different build, or a hand-edited row, must fail
 * loudly at the boundary instead of flowing into the memory insert path as a
 * half-typed object.
 */
const MoneyGateBypassReasonsSchema = z.array(z.string());

/**
 * Row-status narrowing. Exported because `pressure-state.ts` maps the stored
 * status onto the engine's pressure union and must narrow through the SAME
 * vocabulary the mapper does — a second, private copy is exactly how one of the
 * two ends up accepting a value the other rejects. The branch-status and
 * apply-source narrowers below have no such caller and stay private.
 */
export function parseStatus(value: string, id: number): PreparationStatus {
  const match = PREPARATION_STATUSES.find((s) => s === value);
  if (!match) throw new Error(`compaction_preparations: unknown status "${value}" (id=${id})`);
  return match;
}

function parseSummaryStatus(value: string, id: number): SummaryBranchStatus {
  const match = SUMMARY_BRANCH_STATUSES.find((s) => s === value);
  if (!match) {
    throw new Error(`compaction_preparations: unknown summary_status "${value}" (id=${id})`);
  }
  return match;
}

function parseChunksStatus(value: string, id: number): ChunksBranchStatus {
  const match = CHUNKS_BRANCH_STATUSES.find((s) => s === value);
  if (!match) {
    throw new Error(`compaction_preparations: unknown chunks_status "${value}" (id=${id})`);
  }
  return match;
}

function parseApplySource(value: string | null, id: number): ApplySource | null {
  if (value === null) return null;
  const match = APPLY_SOURCES.find((s) => s === value);
  if (!match) throw new Error(`compaction_preparations: unknown apply_source "${value}" (id=${id})`);
  return match;
}

function parseFrozenOutput(value: unknown, id: number): FrozenChunksOutput | null {
  if (value === null || value === undefined) return null;
  const parsed = FrozenChunksOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `compaction_preparations: chunks_frozen_output failed validation (id=${id}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseBypassReasons(value: unknown, id: number): string[] | null {
  if (value === null || value === undefined) return null;
  const parsed = MoneyGateBypassReasonsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `compaction_preparations: money_gate_bypass_reasons failed validation (id=${id}): ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** pg `numeric` arrives as a string; every cost column goes through this. */
function parseCost(value: string | null): number | null {
  return value === null ? null : Number.parseFloat(value);
}

export function mapRow(r: CompactionPreparationRow): CompactionPreparation {
  return {
    id: r.id,
    sessionId: r.session_id,
    status: parseStatus(r.status, r.id),

    watermarkMessageId: r.watermark_message_id,
    baseCheckpointGeneration: r.base_checkpoint_generation,
    targetCheckpointGeneration: r.target_checkpoint_generation,
    frozenSessionSummary: r.frozen_session_summary,
    corpusText: r.corpus_text,
    corpusSha256: r.corpus_sha256,
    corpusFormatVersion: r.corpus_format_version,
    corpusMessageCount: r.corpus_message_count,
    corpusBytes: r.corpus_bytes,
    corpusRedactionHard: r.corpus_redaction_hard,
    corpusRedactionMask: r.corpus_redaction_mask,
    corpusPrunedAt: r.corpus_pruned_at,

    summaryStatus: parseSummaryStatus(r.summary_status, r.id),
    summaryAttemptCount: r.summary_attempt_count,
    summaryMaxAttempts: r.summary_max_attempts,
    summaryNextAttemptAt: r.summary_next_attempt_at,
    summaryLockedAt: r.summary_locked_at,
    summaryLockedBy: r.summary_locked_by,
    summaryHeartbeatAt: r.summary_heartbeat_at,
    summaryLastError: r.summary_last_error,
    summaryOutput: r.summary_output,
    summaryPromptVersion: r.summary_prompt_version,
    summaryProvider: r.summary_provider,
    summaryModel: r.summary_model,
    summaryCompletedAt: r.summary_completed_at,
    summaryCostUsd: parseCost(r.summary_cost_usd),

    chunksStatus: parseChunksStatus(r.chunks_status, r.id),
    chunksAttemptCount: r.chunks_attempt_count,
    chunksMaxAttempts: r.chunks_max_attempts,
    chunksNextAttemptAt: r.chunks_next_attempt_at,
    chunksLockedAt: r.chunks_locked_at,
    chunksLockedBy: r.chunks_locked_by,
    chunksHeartbeatAt: r.chunks_heartbeat_at,
    chunksLastError: r.chunks_last_error,
    chunksFrozenOutput: parseFrozenOutput(r.chunks_frozen_output, r.id),
    chunksFrozenOutputSha256: r.chunks_frozen_output_sha256,
    chunksFrozenAt: r.chunks_frozen_at,
    chunksRejectedByExclusionAtFreeze: r.chunks_rejected_by_exclusion_at_freeze,
    chunksRejectedByRedactionAtFreeze: r.chunks_rejected_by_redaction_at_freeze,
    chunksInserted: r.chunks_inserted,
    chunksDeduped: r.chunks_deduped,
    chunksLandedAfterSupersession: r.chunks_landed_after_supersession,
    chunksProvider: r.chunks_provider,
    chunksModel: r.chunks_model,
    chunksCompletedAt: r.chunks_completed_at,
    chunksCostUsd: parseCost(r.chunks_cost_usd),

    applySource: parseApplySource(r.apply_source, r.id),
    applyRequestedAt: r.apply_requested_at,
    applyStartedAt: r.apply_started_at,
    applyLockedBy: r.apply_locked_by,
    applyHeartbeatAt: r.apply_heartbeat_at,
    applyAttemptCount: r.apply_attempt_count,
    moneyGateBypassReasons: parseBypassReasons(r.money_gate_bypass_reasons, r.id),
    appliedGeneration: r.applied_generation,
    appliedAt: r.applied_at,
    supersededById: r.superseded_by_id,
    lastError: r.last_error,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export const PREPARATION_COLUMNS = `
  id, session_id, status,
  watermark_message_id, base_checkpoint_generation, target_checkpoint_generation,
  frozen_session_summary, corpus_text, corpus_sha256, corpus_format_version,
  corpus_message_count, corpus_bytes, corpus_redaction_hard, corpus_redaction_mask,
  corpus_pruned_at,
  summary_status, summary_attempt_count, summary_max_attempts, summary_next_attempt_at,
  summary_locked_at, summary_locked_by, summary_heartbeat_at, summary_last_error,
  summary_output, summary_prompt_version, summary_provider, summary_model,
  summary_completed_at, summary_cost_usd,
  chunks_status, chunks_attempt_count, chunks_max_attempts, chunks_next_attempt_at,
  chunks_locked_at, chunks_locked_by, chunks_heartbeat_at, chunks_last_error,
  chunks_frozen_output, chunks_frozen_output_sha256, chunks_frozen_at,
  chunks_rejected_by_exclusion_at_freeze, chunks_rejected_by_redaction_at_freeze,
  chunks_inserted, chunks_deduped, chunks_landed_after_supersession,
  chunks_provider, chunks_model, chunks_completed_at, chunks_cost_usd,
  apply_source, apply_requested_at, apply_started_at, apply_locked_by,
  apply_heartbeat_at, apply_attempt_count, money_gate_bypass_reasons,
  applied_generation, applied_at, superseded_by_id, last_error,
  created_at, completed_at
`;
