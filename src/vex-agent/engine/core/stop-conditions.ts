/**
 * Stop conditions — pure functions to evaluate and classify stop reasons.
 *
 * Business stops terminate a run permanently.
 * Runtime pauses are non-business engine states. Some are resumed directly
 * (approval, checkpoint, wake); iteration_limit/timeout are slice guards that
 * mission/full-autonomous runners convert into a wake continuation.
 */

import type {
  StopReason,
  BusinessStopReason,
  RuntimeStopReason,
} from "../types.js";

// ── Classification ──────────────────────────────────────────────

const BUSINESS_STOPS = new Set<string>([
  "goal_reached",
  "deadline_reached",
  "capital_depleted",
  "max_loss_hit",
  "no_viable_opportunity",
  "emergency_stop",
  "user_stopped",
]);

const RUNTIME_PAUSES = new Set<string>([
  "approval_required",
  "checkpoint_pause",
  "iteration_limit",
  "timeout",
  "waiting_for_wake",
  "waiting_for_compact_commit",
  "compact_unable_at_critical",
  "system_error",
  // Plan-mode acceptance pause: a runtime pause, but deliberately NOT a
  // RESUMABLE_STOP — once the plan is accepted it resumes via `plan.accept` or
  // any control resume path, never via a plain user chat message, so ingress
  // must not treat an incoming message as a resume.
  "plan_acceptance_required",
]);

/**
 * The subset of runtime pauses that allow a direct resume path:
 * `approval_required` is resumed by operator approval, `waiting_for_wake` by
 * the wake executor, and `checkpoint_pause` by checkpoint auto-resume.
 * `iteration_limit` and `timeout` are converted by autonomous runners into
 * `waiting_for_wake`; they are not direct ingress-resume statuses.
 * `system_error` remains non-resumable here.
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
