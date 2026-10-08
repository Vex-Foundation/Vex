/**
 * Parallel read segments (Kairos Phase 5, T-1).
 *
 * A model batch is split into ordered segments. A run of two or more
 * CONSECUTIVE calls on the audited allowlist (`tools/parallel-safe-reads.ts`)
 * is one parallel segment; every other call is a serial barrier handled by the
 * unchanged per-call loop in `../turn-loop-tool-batch.ts`. With
 * `AGENT_TOOL_READ_CONCURRENCY=1` no segment is ever planned, so the batch
 * runs the previous serial path exactly.
 *
 * What a segment preserves from the serial path:
 *  - START order is the model's order, and every call is checked for the
 *    operator Stop, lease loss, the wall-clock bounds and the fenced lease
 *    token immediately before it starts, in the serial order of those checks.
 *    After any of them fires nothing new starts; reads already in flight
 *    SETTLE (they are never interrupted here) and are recorded truthfully.
 *  - RESULTS are returned in the ORIGINAL call order whatever order they
 *    finished in, so the caller's single fenced transcript write still pairs
 *    every call with exactly one result.
 *  - the loop detector observes the results in the original order, and only
 *    ordinary completed results, exactly as in the serial loop.
 *  - each call still goes through its own `dispatchWithTiming`, so each
 *    records its own `tool_dispatch_timings` row.
 *
 * Nothing that needs a following step can be in a segment: the allowlist
 * admits no tool that returns an approval, a user form, a Lighter setup
 * hand-off, an engine signal or a prepared-action follow-up. If one ever did,
 * this module fails closed for that call (nothing is enqueued, parked or
 * followed up) instead of acting on it out of order.
 */

import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import type { StopReason } from "../../types.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import {
  READ_PROVIDER_CONCURRENCY_CAPS,
  resolveParallelSafeRead,
  type ReadProvider,
} from "@vex-agent/tools/parallel-safe-reads.js";
import logger from "@utils/logger.js";
import { deriveExplorerRefs } from "../explorer-refs.js";
import { displayStatusPayload } from "../tool-display-status.js";
import {
  isLeaseLost,
  leaseHeldForDispatch,
  type RunnerLeaseGuard,
} from "../../runtime/lease-guard.js";
import { evaluateBatchDeadlines, type BatchDeadlines } from "./deadline.js";
import type { StopPayload } from "./outcome.js";
import {
  BATCH_ABORTED_BY_DEADLINE_OUTPUT,
  BATCH_ABORTED_BY_LEASE_LOST_OUTPUT,
  BATCH_ABORTED_BY_LOOP_CORRECTION_OUTPUT,
  BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
  BATCH_ABORTED_BY_TOOL_CALL_LOOP_OUTPUT,
  BATCH_ABORTED_BY_USER_STOP_OUTPUT,
  type ExecutedResult,
} from "./results.js";
import { scheduleReadSegment } from "./read-segment-scheduler.js";
import { toolCallLoopStopPayload } from "./loop-correction-emit.js";
import type {
  ToolCallLoopDetector,
  ToolCallLoopFacts,
} from "../runner/tool-call-loop-detector.js";

/** Model-visible answer for a segment call that asked for a following step. */
export const PARALLEL_READ_UNEXPECTED_HANDOFF_OUTPUT =
  "This call ran in a group of parallel reads and asked for a following step "
  + "(an approval, a form, a setup or an engine action) that a parallel read may "
  + "not take. Nothing was queued or executed for it. Call it again on its own.";

export interface PlannedReadSegment {
  /** Exclusive end index in the batch. */
  readonly end: number;
  readonly providers: readonly ReadProvider[];
}

/** Key-order-independent identity of a call's name and arguments. */
function callIdentity(call: ParsedToolCall): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record).sort().map((key) => [key, canonical(record[key])]),
      );
    }
    return value;
  };
  return JSON.stringify([call.name, canonical(call.arguments)]);
}

/**
 * The parallel segment starting at `start`, or `null` when the call there is
 * a serial barrier, the run of allowlisted reads is shorter than two, or the
 * limit is 1 (strictly serial, the previous behaviour).
 *
 * A call identical (same tool, same arguments) to one earlier in the segment
 * ENDS it. Running a repeat concurrently buys nothing, and serially the loop
 * detector sees each repeat's result before the next one starts, so a polling
 * burst is still stopped exactly where it would have been without this lane.
 */
export function planReadSegment(
  toolCalls: readonly ParsedToolCall[],
  start: number,
  limit: number,
): PlannedReadSegment | null {
  if (limit <= 1) return null;
  const providers: ReadProvider[] = [];
  const seen = new Set<string>();
  for (let j = start; j < toolCalls.length; j++) {
    const call = toolCalls[j];
    if (call === undefined) break;
    const entry = resolveParallelSafeRead(call.name);
    if (entry === null) break;
    const identity = callIdentity(call);
    if (seen.has(identity)) break;
    seen.add(identity);
    providers.push(entry.provider);
  }
  return providers.length >= 2 ? { end: start + providers.length, providers } : null;
}

interface StartRefusal {
  readonly stopReason: StopReason;
  readonly output: string;
}

export interface ReadSegmentStop {
  /** First batch index to drain with `drainOutput` (everything after it too). */
  readonly drainFrom: number;
  readonly drainOutput: string;
  /** `null` for the loop detector's first-strike correction (the turn goes on). */
  readonly stopReason: StopReason | null;
  readonly stopPayload?: StopPayload;
  readonly loopCorrectionFacts?: ToolCallLoopFacts;
}

export interface ReadSegmentOutcome {
  /** Calls that STARTED, each paired with its one result, in batch order. */
  readonly executed: ReadonlyArray<{
    readonly call: ParsedToolCall;
    readonly result: ExecutedResult;
  }>;
  readonly started: number;
  readonly stop: ReadSegmentStop | null;
}

function hasHandOff(result: ToolResult): boolean {
  return result.pendingApproval === true
    || result.pendingUserForm !== undefined
    || result.lighterSetupHandoff !== undefined
    || result.preparedActionFollowUp !== undefined
    || result.engineSignal !== undefined;
}

function completedEntry(call: ParsedToolCall, result: ToolResult): ExecutedResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: result.output,
    success: result.success,
    explorerRefs: deriveExplorerRefs(result.data),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...displayStatusPayload(result.data),
  };
}

function refusedHandOffEntry(call: ParsedToolCall): ExecutedResult {
  return {
    toolCallId: call.id,
    toolName: call.name,
    output: PARALLEL_READ_UNEXPECTED_HANDOFF_OUTPUT,
    success: false,
    explorerRefs: [],
  };
}

export async function runReadSegment(args: {
  readonly toolCalls: readonly ParsedToolCall[];
  readonly start: number;
  readonly segment: PlannedReadSegment;
  readonly limit: number;
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly abortSignal?: AbortSignal;
  readonly leaseGuard?: RunnerLeaseGuard;
  readonly deadlines?: BatchDeadlines;
  readonly loopDetector?: ToolCallLoopDetector;
  /** Dispatch ONE call exactly as the serial loop does (context, timing, dispatcher). */
  readonly dispatch: (call: ParsedToolCall) => Promise<ToolResult>;
}): Promise<ReadSegmentOutcome> {
  const { toolCalls, start, segment } = args;
  const count = segment.end - start;
  const callAt = (position: number): ParsedToolCall => {
    const call = toolCalls[start + position];
    if (call === undefined) throw new Error("read segment position out of range");
    return call;
  };

  // The serial loop's pre-dispatch checks, in the same order, per call.
  const beforeStart = async (): Promise<StartRefusal | null> => {
    if (args.abortSignal?.aborted) {
      return { stopReason: "user_stopped", output: BATCH_ABORTED_BY_USER_STOP_OUTPUT };
    }
    if (isLeaseLost(args.leaseGuard)) {
      return { stopReason: "lease_lost", output: BATCH_ABORTED_BY_LEASE_LOST_OUTPUT };
    }
    const breach = evaluateBatchDeadlines(args.deadlines, Date.now());
    if (breach !== null) {
      return breach.kind === "mission_deadline"
        ? { stopReason: "deadline_reached", output: BATCH_ABORTED_BY_DEADLINE_OUTPUT }
        : { stopReason: "timeout", output: BATCH_ABORTED_BY_TIMEOUT_OUTPUT };
    }
    if (args.leaseGuard !== undefined && !(await leaseHeldForDispatch(args.leaseGuard))) {
      return { stopReason: "lease_lost", output: BATCH_ABORTED_BY_LEASE_LOST_OUTPUT };
    }
    return null;
  };

  const schedule = await scheduleReadSegment<ToolResult, StartRefusal, ReadProvider>({
    count,
    limit: args.limit,
    providerOf: (position) => segment.providers[position] ?? "local",
    providerCap: (provider) => READ_PROVIDER_CONCURRENCY_CAPS[provider],
    beforeStart,
    dispatch: (position) => args.dispatch(callAt(position)),
  });

  logger.debug("engine.turn.parallel_read_segment", {
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    size: count,
    started: schedule.started,
    limit: args.limit,
  });

  // A throwing dispatch ends the batch exactly as it does serially, but only
  // after every sibling in flight has settled.
  if (schedule.error !== null) throw schedule.error.value;

  const settled: Array<{ call: ParsedToolCall; result: ToolResult }> = [];
  for (let position = 0; position < schedule.started; position++) {
    const result = schedule.results[position];
    if (result === undefined) throw new Error("read segment lost a settled result");
    settled.push({ call: callAt(position), result });
  }
  const firstUnstarted = start + schedule.started;

  // ── Stop / lease loss, re-checked AFTER the in-flight reads settled ──
  // Same shape as the serial loop's post-dispatch re-checks: the reads that
  // ran are recorded truthfully, nothing after them runs. Stop outranks lease.
  const postStop: StartRefusal | null = args.abortSignal?.aborted
    ? { stopReason: "user_stopped", output: BATCH_ABORTED_BY_USER_STOP_OUTPUT }
    : isLeaseLost(args.leaseGuard)
      ? { stopReason: "lease_lost", output: BATCH_ABORTED_BY_LEASE_LOST_OUTPUT }
      : null;
  if (postStop !== null) {
    return {
      executed: settled.map(({ call, result }) => ({
        call,
        result: hasHandOff(result) ? refusedHandOffEntry(call) : completedEntry(call, result),
      })),
      started: schedule.started,
      stop: {
        drainFrom: firstUnstarted,
        drainOutput: postStop.output,
        stopReason: postStop.stopReason,
      },
    };
  }

  const executed: Array<{ call: ParsedToolCall; result: ExecutedResult }> = [];
  let loopStop: ReadSegmentStop | null = null;
  for (const { call, result } of settled) {
    if (hasHandOff(result)) {
      logger.error("engine.turn.parallel_read_unexpected_handoff", {
        sessionId: args.sessionId,
        missionRunId: args.missionRunId,
        toolName: call.name,
      });
      executed.push({ call, result: refusedHandOffEntry(call) });
      continue;
    }
    executed.push({ call, result: completedEntry(call, result) });
    // Once the detector has answered, the reads that already ran are recorded
    // truthfully but no longer observed: the serial loop would have stopped
    // observing at the same point.
    if (loopStop !== null) continue;
    const verdict = args.loopDetector?.observe({
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
      output: result.output,
      success: result.success,
    }) ?? { kind: "clear" as const };
    if (verdict.kind === "correct") {
      logger.warn("engine.turn.tool_call_loop_corrected", {
        sessionId: args.sessionId,
        missionRunId: args.missionRunId,
        toolName: verdict.facts.toolName,
        cycleLength: verdict.facts.cycleLength,
        repeatCount: verdict.facts.repeatCount,
        callsDrained: toolCalls.length - firstUnstarted,
      });
      loopStop = {
        drainFrom: firstUnstarted,
        drainOutput: BATCH_ABORTED_BY_LOOP_CORRECTION_OUTPUT,
        stopReason: null,
        loopCorrectionFacts: verdict.facts,
      };
    } else if (verdict.kind === "stop") {
      logger.warn("engine.turn.tool_call_loop_stop", {
        sessionId: args.sessionId,
        missionRunId: args.missionRunId,
        toolName: verdict.facts.toolName,
        cycleLength: verdict.facts.cycleLength,
        repeatCount: verdict.facts.repeatCount,
        callsDrained: toolCalls.length - firstUnstarted,
      });
      loopStop = {
        drainFrom: firstUnstarted,
        drainOutput: BATCH_ABORTED_BY_TOOL_CALL_LOOP_OUTPUT,
        stopReason: "tool_call_loop",
        stopPayload: toolCallLoopStopPayload(verdict.facts),
      };
    }
  }

  if (loopStop !== null) {
    return { executed, started: schedule.started, stop: loopStop };
  }
  if (schedule.refusal !== null) {
    return {
      executed,
      started: schedule.started,
      stop: {
        drainFrom: firstUnstarted,
        drainOutput: schedule.refusal.output,
        stopReason: schedule.refusal.stopReason,
      },
    };
  }
  return { executed, started: schedule.started, stop: null };
}
