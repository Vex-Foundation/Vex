/**
 * Runtime timings repo — per-attempt inference, per-dispatch tool, and
 * per-turn-run timing rows (migration 171).
 *
 * Telemetry only: nothing in the runtime reads these rows to decide anything.
 * Callers on the turn path must go through `recordInBackground` so a failed
 * write can never slow or break a turn. Every field is sanitised by the
 * caller — numbers, enums, IDs, tool/model/provider names, error classes;
 * never message content, tool arguments/results, or raw error text.
 */

import logger from "@utils/logger.js";
import { execute } from "../client.js";

export interface InferenceAttemptRecord {
  sessionId: string;
  missionRunId: string | null;
  turnRunId: string;
  iteration: number;
  streamId: string | null;
  startedAt: Date;
  outcome: "completed" | "aborted" | "timeout" | "error";
  errorClass: string | null;
  model: string | null;
  /** OpenRouter endpoint tag the attempt ran on; NULL when unpinned. */
  endpointTag: string | null;
  servingProvider: string | null;
  requestedEffort: string | null;
  bufferedFallback: boolean;
  fallbackReason: string | null;
  capacityRetries: number;
  capacityRetryClasses: readonly string[];
  preInferenceMs: number | null;
  promptStackMs: number | null;
  firstChunkMs: number | null;
  firstReasoningMs: number | null;
  firstSemanticMs: number | null;
  reasoningOnlyMs: number | null;
  maxInterChunkGapMs: number | null;
  totalMs: number;
  chunkCount: number;
  finishReason: string | null;
  contentEmpty: boolean | null;
  toolCallCount: number | null;
  validToolCallCount: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
  generationId: string | null;
}

export interface ToolDispatchTimingRecord {
  sessionId: string;
  turnRunId: string;
  iteration: number;
  toolCallId: string | null;
  toolName: string;
  actionKind: string | null;
  startedAt: Date;
  durationMs: number;
  outcome: "success" | "failure" | "error";
}

export interface TurnRunTimingRecord {
  turnRunId: string;
  sessionId: string;
  missionRunId: string | null;
  sessionKind: string | null;
  startedAt: Date;
  totalMs: number;
  iterations: number;
  toolCalls: number;
  /** Entry point start → `runTurnLoop` start; NULL when the caller gave none. */
  queueWaitMs: number | null;
  /** Total time the loop spent awaiting transcript writes. */
  persistMs: number;
  outcome: "returned" | "error";
  stopReason: string | null;
  errorClass: string | null;
}

/** Durations come from `performance.now()` deltas; the columns are INTEGER. */
function ms(value: number): number {
  return Math.round(value);
}

function msOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

export async function insertInferenceAttempt(r: InferenceAttemptRecord): Promise<void> {
  await execute(
    `INSERT INTO inference_attempts (
       session_id, mission_run_id, turn_run_id, iteration, stream_id, started_at,
       outcome, error_class, model, endpoint_tag, serving_provider, requested_effort,
       buffered_fallback, fallback_reason, capacity_retries, capacity_retry_classes,
       pre_inference_ms, prompt_stack_ms, first_chunk_ms, first_reasoning_ms,
       first_semantic_ms, reasoning_only_ms, max_inter_chunk_gap_ms, total_ms,
       chunk_count, finish_reason, content_empty, tool_call_count, valid_tool_call_count,
       prompt_tokens, completion_tokens, reasoning_tokens, cached_tokens, generation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
             $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33,
             $34)`,
    [r.sessionId, r.missionRunId, r.turnRunId, r.iteration, r.streamId, r.startedAt,
     r.outcome, r.errorClass, r.model, r.endpointTag, r.servingProvider, r.requestedEffort,
     r.bufferedFallback, r.fallbackReason, r.capacityRetries, [...r.capacityRetryClasses],
     msOrNull(r.preInferenceMs), msOrNull(r.promptStackMs), msOrNull(r.firstChunkMs),
     msOrNull(r.firstReasoningMs), msOrNull(r.firstSemanticMs), msOrNull(r.reasoningOnlyMs),
     msOrNull(r.maxInterChunkGapMs), ms(r.totalMs),
     r.chunkCount, r.finishReason, r.contentEmpty, r.toolCallCount, r.validToolCallCount,
     r.promptTokens, r.completionTokens, r.reasoningTokens, r.cachedTokens, r.generationId],
  );
}

export async function insertToolDispatchTiming(r: ToolDispatchTimingRecord): Promise<void> {
  await execute(
    `INSERT INTO tool_dispatch_timings (
       session_id, turn_run_id, iteration, tool_call_id, tool_name, action_kind,
       started_at, duration_ms, outcome)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [r.sessionId, r.turnRunId, r.iteration, r.toolCallId, r.toolName, r.actionKind,
     r.startedAt, ms(r.durationMs), r.outcome],
  );
}

export async function insertTurnRunTiming(r: TurnRunTimingRecord): Promise<void> {
  await execute(
    `INSERT INTO turn_run_timings (
       turn_run_id, session_id, mission_run_id, session_kind, started_at, total_ms,
       iterations, tool_calls, queue_wait_ms, persist_ms, outcome, stop_reason, error_class)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [r.turnRunId, r.sessionId, r.missionRunId, r.sessionKind, r.startedAt, ms(r.totalMs),
     r.iterations, r.toolCalls, msOrNull(r.queueWaitMs), ms(r.persistMs), r.outcome, r.stopReason, r.errorClass],
  );
}

/**
 * At most this many telemetry writes may be in flight at once. Each one holds a
 * pool connection while it runs; if the database is slow, an unbounded backlog
 * of timing rows would compete with the turn's own transcript writes for the
 * same pool. Past the cap a row is DROPPED, never queued: a queue would only
 * move the backlog into memory and replay it while the database is already
 * struggling.
 */
export const MAX_IN_FLIGHT_TELEMETRY_WRITES = 4;

/** `runtime_timings.dropped` is logged at most once per this window. */
export const DROPPED_LOG_INTERVAL_MS = 60_000;

let inFlightWrites = 0;
let droppedTotal = 0;
let droppedSinceLog = 0;
let lastDropLogAtMs: number | null = null;
let clock: () => number = () => performance.now();

export interface TelemetryWriteStats {
  readonly inFlight: number;
  /** Rows dropped at the cap since the process started (or the last test reset). */
  readonly dropped: number;
}

export function getTelemetryWriteStats(): TelemetryWriteStats {
  return { inFlight: inFlightWrites, dropped: droppedTotal };
}

/** Test-only: clear the counters and optionally swap the monotonic clock. */
export function resetTelemetryWriteStatsForTests(now?: () => number): void {
  inFlightWrites = 0;
  droppedTotal = 0;
  droppedSinceLog = 0;
  lastDropLogAtMs = null;
  clock = now ?? (() => performance.now());
}

/**
 * Logs the drops accumulated since the last log, if there are any and the
 * interval has passed. Called on every drop and every settled write rather
 * than from a timer, so nothing stays scheduled once telemetry goes quiet.
 */
function maybeLogDrops(): void {
  if (droppedSinceLog === 0) return;
  const now = clock();
  if (lastDropLogAtMs !== null && now - lastDropLogAtMs < DROPPED_LOG_INTERVAL_MS) return;
  const dropped = droppedSinceLog;
  droppedSinceLog = 0;
  lastDropLogAtMs = now;
  try {
    logger.warn("runtime_timings.dropped", {
      dropped,
      droppedTotal,
      maxInFlight: MAX_IN_FLIGHT_TELEMETRY_WRITES,
    });
  } catch {
    // Logging must not turn a dropped telemetry row into a turn failure.
  }
}

/**
 * Fire-and-forget wrapper: never throws, never awaited by callers, logs
 * `runtime_timings.write_failed`.
 *
 * A synchronous throw from `write` is caught too, so a caller can pass any
 * thunk without guarding it. The log carries only the label and the error's
 * class name — a driver error message can echo bound parameter values.
 *
 * Bounded: with `MAX_IN_FLIGHT_TELEMETRY_WRITES` writes already running, the
 * row is dropped without calling `write`, counted, and reported through a
 * throttled `runtime_timings.dropped` warning. A slot is freed when its write
 * settles, whether it succeeded or failed.
 */
export function recordInBackground(label: string, write: () => Promise<void>): void {
  if (inFlightWrites >= MAX_IN_FLIGHT_TELEMETRY_WRITES) {
    droppedTotal += 1;
    droppedSinceLog += 1;
    try {
      maybeLogDrops();
    } catch {
      // Never throws: the caller is on the turn path.
    }
    return;
  }
  inFlightWrites += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    try {
      maybeLogDrops();
    } catch {
      // A settled write must never surface as an unhandled rejection.
    }
  };
  const onFailure = (err: unknown): void => {
    release();
    try {
      logger.warn("runtime_timings.write_failed", {
        label,
        errorClass: err instanceof Error ? err.name : typeof err,
      });
    } catch {
      // Logging must not turn a dropped telemetry row into a turn failure.
    }
  };
  try {
    void write().then(release, onFailure);
  } catch (err) {
    onFailure(err);
  }
}
