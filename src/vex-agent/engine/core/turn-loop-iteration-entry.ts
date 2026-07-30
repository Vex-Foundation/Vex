/**
 * Iteration-entry boundary — runs the checks at the top of every loop
 * iteration in this order:
 *
 *   1. Abort signal (user_stopped)
 *   2. Pending control request (paused_user / stopped via puzzle-03
 *      observe-and-apply)
 *   3. Runtime stop conditions (iteration_limit, timeout)
 *   4. Boundary actions (compaction apply, then compaction trigger)
 *
 * The order is contract: abort wins over a pending control request,
 * and the control request wins over a runtime stop so a user-pause
 * always lands cleanly even at the iteration that would have hit
 * iteration_limit anyway. Steps 1-3 always outrank step 4 — a session
 * that is stopping must never start compaction work on its way out.
 *
 * The helper RETURNS the outcome and never increments the mission-run
 * iteration counter — caller increments AFTER the `proceed` outcome
 * so the counter only ticks for iterations that actually run a turn.
 *
 * `emitTurnLoopControlState` stays in the caller (matches the
 * v4-codex contract: "emit at the loop boundary, decisions in the
 * helper"). The helper just surfaces the discriminated `control_*`
 * outcomes so the caller can run the canonical emit.
 *
 * ── Boundary actions (step 4) ──────────────────────────────────
 *
 * Actions are OUTCOME-BEARING and SHORT-CIRCUITING. An earlier design had
 * them return `void` on the theory that boundary work "can never affect the
 * outcome"; that cannot express a cutover that just happened, so the caller
 * would have had to rediscover it. The first action returning anything other
 * than `continue` ends the pipeline and its outcome becomes the iteration's
 * outcome.
 *
 * PHASE ORDER IS STRUCTURAL, not a call-site convention. Every `apply`-phase
 * action runs before every `trigger`-phase action, whatever order the caller
 * listed them in, because a requested or forced apply must win before a
 * trigger could supersede that very preparation or re-fork a fresh corpus from
 * lagging pressure. Three packages edit the call site across build stages, so
 * a contract that depended on array order would be one careless reorder away
 * from silently inverting.
 *
 * A throwing action is logged and SKIPPED — the pipeline continues with the
 * next action and the iteration still proceeds. Compaction is an optimisation;
 * it must never be able to kill a running loop.
 *
 * Actions MUST NOT do unbounded external work (no provider call, no wallet
 * call, no signing): this sits on the operator-Stop latency path. DB work
 * inside a short transaction is the intended cost ceiling.
 *
 * `compaction_apply_deferred` is NOT a failed compaction. The caller must NOT
 * count it toward `criticalNoopCounter` — deferring for unresolved money state
 * is the gate working, and counting it would escalate a healthy run to
 * `paused_error` for waiting correctly.
 */

import type { MoneyStateReason } from "@vex-agent/db/repos/approval-intents/money-state.js";
import logger from "@utils/logger.js";
import type { RuntimeStopReason } from "../types.js";
import { evaluateRuntimeStopConditions } from "./stop-conditions.js";
import { observePendingControlRequest } from "./turn-loop-observe.js";

/**
 * `apply` consumes an already-requested or forced cutover; `trigger` may fork
 * a new preparation. Apply always runs first — see the header.
 */
export type IterationBoundaryPhase = "apply" | "trigger";

export type IterationBoundaryOutcome =
  | { kind: "continue" }
  | { kind: "compaction_applied"; generation: number; archivedMessages: number }
  | {
      kind: "compaction_apply_deferred";
      reasons: readonly MoneyStateReason[];
    };

export interface IterationBoundaryAction {
  /** Stable identifier used in failure logs. */
  readonly name: string;
  readonly phase: IterationBoundaryPhase;
  run(): Promise<IterationBoundaryOutcome>;
}

export type IterationEntryOutcome =
  | { kind: "proceed" }
  | { kind: "abort_user_stopped" }
  | { kind: "control_paused_user"; correlationId: string | null }
  | { kind: "control_stopped"; correlationId: string | null }
  | { kind: "runtime_stop"; stopReason: RuntimeStopReason }
  | { kind: "compaction_applied"; generation: number; archivedMessages: number }
  | {
      kind: "compaction_apply_deferred";
      reasons: readonly MoneyStateReason[];
    };

const BOUNDARY_PHASE_ORDER: readonly IterationBoundaryPhase[] = [
  "apply",
  "trigger",
];

async function runBoundaryActions(
  sessionId: string,
  actions: readonly IterationBoundaryAction[],
): Promise<IterationEntryOutcome | null> {
  for (const phase of BOUNDARY_PHASE_ORDER) {
    for (const action of actions) {
      if (action.phase !== phase) continue;
      try {
        const outcome = await action.run();
        if (outcome.kind !== "continue") return outcome;
      } catch (error) {
        logger.error("turn-loop.iteration_action_failed", {
          sessionId,
          action: action.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  return null;
}

export async function runIterationEntryGuards(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly abortSignal?: AbortSignal;
  readonly iteration: number;
  readonly maxIterations: number;
  readonly elapsedMs: number;
  readonly timeoutMs: number;
  /**
   * Non-stop boundary work. Runs ONLY when all three guards pass, and only
   * reaches `proceed` when no action short-circuits.
   */
  readonly boundaryActions?: readonly IterationBoundaryAction[];
}): Promise<IterationEntryOutcome> {
  if (args.abortSignal?.aborted) {
    return { kind: "abort_user_stopped" };
  }

  if (args.missionRunId !== null) {
    const observeOutcome = await observePendingControlRequest({
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
    });
    if (observeOutcome.kind === "paused_user_applied") {
      return {
        kind: "control_paused_user",
        correlationId: observeOutcome.correlationId,
      };
    }
    if (observeOutcome.kind === "stop_applied") {
      return {
        kind: "control_stopped",
        correlationId: observeOutcome.correlationId,
      };
    }
    // `no_request` / `observe_error` — fall through; helper already logged
    // the error case via `turn-loop.observe_control_failed`.
  }

  const runtimeStop = evaluateRuntimeStopConditions({
    iterationCount: args.iteration,
    maxIterations: args.maxIterations,
    elapsedMs: args.elapsedMs,
    timeoutMs: args.timeoutMs,
  });
  if (runtimeStop) {
    return { kind: "runtime_stop", stopReason: runtimeStop };
  }

  if (args.boundaryActions && args.boundaryActions.length > 0) {
    const actionOutcome = await runBoundaryActions(
      args.sessionId,
      args.boundaryActions,
    );
    if (actionOutcome) return actionOutcome;
  }

  return { kind: "proceed" };
}
