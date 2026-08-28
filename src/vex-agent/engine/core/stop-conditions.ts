/**
 * Stop conditions — pure functions to evaluate and classify stop reasons.
 *
 * Business stops terminate a run permanently.
 * Runtime pauses are non-business engine states. Some are resumed directly
 * (approval, checkpoint, wake); iteration_limit/timeout are slice guards that
 * mission/full-autonomous runners convert into a wake continuation.
 */

import {
  BUSINESS_STOP_REASONS,
  RUNTIME_STOP_REASONS,
  type StopReason,
  type BusinessStopReason,
  type RuntimeStopReason,
} from "../types.js";

// ── Classification ──────────────────────────────────────────────

/**
 * Both sets are DERIVED from the canonical tuples in `types/stop-reasons.ts`,
 * never re-typed here.
 *
 * `isRuntimePause` declares `reason is RuntimeStopReason`, which is a promise
 * that it answers `true` for every member of that union. A hand-maintained
 * list could not keep that promise and did not: `user_paused`,
 * `user_form_required` and (before this) every newly added runtime stop were
 * missing, so the predicate narrowed to a type it had just denied. Building
 * the set from the union's own tuple makes the promise structural - a new
 * member is classified the moment it is declared, not the moment someone
 * remembers this file.
 *
 * `RESUMABLE_STOPS` below is deliberately NOT derived: it is a genuine policy
 * subset, so every member is a decision and the default for a new stop reason
 * must be "not directly resumable".
 */
const BUSINESS_STOPS: ReadonlySet<string> = new Set<string>(BUSINESS_STOP_REASONS);

const RUNTIME_PAUSES: ReadonlySet<string> = new Set<string>(RUNTIME_STOP_REASONS);

/**
 * The subset of runtime pauses that allow a direct resume path:
 * `approval_required` is resumed by operator approval, `waiting_for_wake` by
 * the wake executor, and `checkpoint_pause` by checkpoint auto-resume.
 * `iteration_limit` and `timeout` are converted by autonomous runners into
 * `waiting_for_wake`; they are not direct ingress-resume statuses.
 * `system_error` remains non-resumable here, and so are `restart_orphan` and
 * `tool_call_loop`: the first needs a fresh run (the process that owned the
 * old one is gone), the second needs a human to change something, because
 * resuming is precisely what the model just proved it would repeat.
 */
const RESUMABLE_STOPS = new Set<string>([
  "approval_required",
  "waiting_for_wake",
  "checkpoint_pause",
]);

export function isBusinessStop(reason: StopReason): reason is BusinessStopReason {
  return BUSINESS_STOPS.has(reason);
}

export function isRuntimePause(reason: StopReason): reason is RuntimeStopReason {
  return RUNTIME_PAUSES.has(reason);
}

/**
 * Whether this stop reason can lead to a resume (vs permanent termination
 * or a re-kick requirement). Used by PR-7 ingress routing to decide
 * whether a user message should resume an existing run or preempt a
 * pending wake.
 */
export function isResumablePause(reason: StopReason): boolean {
  return RESUMABLE_STOPS.has(reason);
}

/**
 * Whether this stop reason should permanently terminate the run.
 * Business stops → terminate. Runtime pauses → resumable.
 */
export function shouldTerminateRun(reason: StopReason): boolean {
  return isBusinessStop(reason);
}

// ── Evaluation ──────────────────────────────────────────────────

export interface StopConditionContext {
  iterationCount: number;
  maxIterations: number;
  elapsedMs: number;
  timeoutMs: number;
}

/**
 * Evaluate runtime stop conditions against current run state.
 * Returns the first matching stop reason, or null if none apply.
 *
 * Business stop conditions (goal_reached, capital_depleted, etc.)
 * are evaluated by the model via tool results, not by this function.
 */
export function evaluateRuntimeStopConditions(
  context: StopConditionContext,
): RuntimeStopReason | null {
  if (context.iterationCount >= context.maxIterations) {
    return "iteration_limit";
  }

  if (context.elapsedMs >= context.timeoutMs) {
    return "timeout";
  }

  return null;
}

// ── Business stop detection ──────────────────────────────────────
//
// Business stops are now triggered via the `MissionStop` internal tool,
// not by parsing model text. The tool returns an engineSignal that the
// turn-loop uses to finalize the run. See tools/internal/mission.ts.
//
// parseBusinessStopFromText() has been removed — it was a weak contract
// (model text is unreliable for structured signaling).
