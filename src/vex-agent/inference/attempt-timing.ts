/**
 * Inference attempt timing (Kairos Phase 1, runtime measurement).
 *
 * A small mutable observer that `runStreamingInference` feeds while one
 * inference attempt runs: when the request started, when each chunk arrived,
 * whether it degraded to the buffered path, how many capacity failures the
 * endpoint failover absorbed, and how many tool calls survived assembly. The
 * caller snapshots it once the attempt ends — completed, aborted or thrown —
 * so failed and retried attempts are measured the same way as successful ones.
 *
 * It records numbers, chunk TYPES and bounded reason labels only. It never
 * sees chunk text, tool arguments or error messages, so nothing it holds can
 * leak prompt or transaction content into telemetry.
 *
 * Durations use a monotonic clock (`performance.now()` by default); every ms
 * field in a snapshot is relative to `markRequestStart`.
 */

import type { StreamChunk } from "./types.js";

export interface InferenceAttemptTimer {
  /** Call at `runStreamingInference` entry. */
  markRequestStart(): void;
  /**
   * Call for every chunk. Tracks first chunk, first reasoning, first semantic
   * (content | tool_call_delta), the largest inter-chunk gap, and the count.
   */
  markChunk(type: StreamChunk["type"]): void;
  markBufferedFallback(reason: string): void;
  markCapacityFailure(reasonClass: string): void;
  markToolCalls(total: number, valid: number): void;
  /** Ms fields relative to request start; `endedAtMs` defaults to now. */
  snapshot(endedAtMs?: number): InferenceAttemptTimingSnapshot;
}

export interface InferenceAttemptTimingSnapshot {
  firstChunkMs: number | null;
  firstReasoningMs: number | null;
  firstSemanticMs: number | null;
  reasoningOnlyMs: number | null;
  maxInterChunkGapMs: number | null;
  totalMs: number;
  chunkCount: number;
  bufferedFallback: boolean;
  fallbackReason: string | null;
  capacityRetries: number;
  capacityRetryClasses: string[];
  toolCallCount: number | null;
  validToolCallCount: number | null;
}

function defaultNow(): number {
  return performance.now();
}

export function createInferenceAttemptTimer(
  now: () => number = defaultNow,
): InferenceAttemptTimer {
  let startedAt: number | null = null;
  let firstChunkAt: number | null = null;
  let firstReasoningAt: number | null = null;
  let firstSemanticAt: number | null = null;
  let lastChunkAt: number | null = null;
  let maxGap: number | null = null;
  let chunkCount = 0;
  let fallbackReason: string | null = null;
  let bufferedFallback = false;
  const capacityRetryClasses: string[] = [];
  let toolCallCount: number | null = null;
  let validToolCallCount: number | null = null;

  // A chunk or fallback observed before `markRequestStart` still needs an
  // origin; the first observation stands in for it rather than yielding NaN.
  const origin = (at: number): number => {
    if (startedAt === null) startedAt = at;
    return startedAt;
  };

  return {
    markRequestStart() {
      startedAt = now();
    },

    markChunk(type) {
      const at = now();
      origin(at);
      if (firstChunkAt === null) firstChunkAt = at;
      if (type === "reasoning" && firstReasoningAt === null) firstReasoningAt = at;
      if ((type === "content" || type === "tool_call_delta") && firstSemanticAt === null) {
        firstSemanticAt = at;
      }
      if (lastChunkAt !== null) {
        const gap = at - lastChunkAt;
        if (maxGap === null || gap > maxGap) maxGap = gap;
      }
      lastChunkAt = at;
      chunkCount += 1;
    },

    markBufferedFallback(reason) {
      bufferedFallback = true;
      fallbackReason = reason;
    },

    markCapacityFailure(reasonClass) {
      capacityRetryClasses.push(reasonClass);
    },

    markToolCalls(total, valid) {
      toolCallCount = total;
      validToolCallCount = valid;
    },

    snapshot(endedAtMs) {
      const end = endedAtMs ?? now();
      const start = origin(end);
      const rel = (at: number | null): number | null => (at === null ? null : at - start);

      let reasoningOnlyMs: number | null = null;
      if (firstReasoningAt !== null) {
        reasoningOnlyMs =
          firstSemanticAt !== null ? firstSemanticAt - firstReasoningAt : end - firstReasoningAt;
      }

      return {
        firstChunkMs: rel(firstChunkAt),
        firstReasoningMs: rel(firstReasoningAt),
        firstSemanticMs: rel(firstSemanticAt),
        reasoningOnlyMs,
        maxInterChunkGapMs: maxGap,
        totalMs: end - start,
        chunkCount,
        bufferedFallback,
        fallbackReason,
        capacityRetries: capacityRetryClasses.length,
        capacityRetryClasses: [...capacityRetryClasses],
        toolCallCount,
        validToolCallCount,
      };
    },
  };
}

/** Identifier-shaped labels only: an error `.name` is normally a class name. */
const NAME_RE = /^[A-Za-z_$][\w$.-]{0,63}$/;
/** OpenRouter `errorType` is an open enum of snake_case-ish labels. */
const ERROR_TYPE_RE = /^[\w.:-]{1,64}$/;

/**
 * Sanitised error class for telemetry: `name`, plus `:status=<n>` when a
 * numeric status own-property exists (see `attachStatus`), plus
 * `:type=<errorType>` when one was attached (see `attachErrorType`).
 *
 * NEVER reads `.message`, `.cause`, `.body` or any other free-text field.
 * A name or type that does not look like a bounded label is dropped rather
 * than recorded, so even an error whose `name` was set from user text cannot
 * carry that text into a row. Abort errors (`AbortError`, or Node's
 * `code: "ABORT_ERR"`) classify as `AbortError`.
 */
export function classifyInferenceError(err: unknown): string {
  if (typeof err !== "object" || err === null) return "unknown";
  const record = err as Record<string, unknown>;

  let name: string;
  if (record.name === "AbortError" || record.code === "ABORT_ERR") {
    name = "AbortError";
  } else if (typeof record.name === "string" && NAME_RE.test(record.name)) {
    name = record.name;
  } else {
    name = "unknown";
  }

  let out = name;
  const status = Object.prototype.hasOwnProperty.call(err, "status")
    ? record.status
    : Object.prototype.hasOwnProperty.call(err, "statusCode")
      ? record.statusCode
      : undefined;
  if (typeof status === "number" && Number.isFinite(status)) {
    out += `:status=${Math.trunc(status)}`;
  }
  const errorType = record.errorType;
  if (typeof errorType === "string" && ERROR_TYPE_RE.test(errorType)) {
    out += `:type=${errorType}`;
  }
  return out;
}
