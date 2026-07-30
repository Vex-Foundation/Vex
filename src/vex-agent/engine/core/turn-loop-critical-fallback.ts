/**
 * Critical-band forced compact fallback — proactive runtime safety net
 * invoked at iteration top when `turnBand === "critical"`. Extracted
 * from `turn-loop.ts` for scaling.
 *
 * The helper drives the noop-counter + skip-one-shot state machine and
 * orchestrates the three terminal emit paths (committed log, noop log,
 * escalation: status + log + bug-emit). Caller threads the new
 * state-value back into the loop's closure and, on `committed`, runs
 * `applyPostCompactBookkeeping` + re-observes the band (caller scope
 * because both depend on closure state).
 *
 * Escalation ORDERING is bit-for-bit preserved with the pre-extraction
 * code (status write → `logger.error` → bug-emit). Codex flagged this
 * ordering in puzzle 03 review — keeping the same order across the
 * helper boundary is a hard requirement. The status WRITE itself is
 * now guarded (`updateStatusIfNotTerminal`), because a Stop can land
 * terminally while the forced compaction below is awaited; see the
 * comment at the escalation site.
 *
 * This is NOT the only write for this escalation, and it is not the
 * deciding one. The caller breaks the loop with
 * `stopReason = "compact_unable_at_critical"`, and
 * `runner/mission-finalize.ts` writes the run row again — LAST, and
 * therefore authoritatively. Both writes go through the same repo CAS
 * so the invariant "a terminal user stop is never reopened" holds at
 * every interleaving, including a Stop that lands after this helper's
 * own CAS succeeded. If you add a third write to this chain, it goes
 * through `updateStatusIfNotTerminal` too; `updateStatus` is only for
 * writes that move a run TO a terminal state.
 */

import {
  resolveCriticalCompaction,
  type CriticalCompactionInput,
} from "./critical-compaction.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { pressureFraction, type ContextUsageBand } from "./context-band.js";
import { emitCompactUnableAtCriticalBug } from "./turn-loop-bug-emit.js";
import logger from "@utils/logger.js";

export const COMPACT_MAX_CONSECUTIVE_NOOPS = 2;

export type CriticalBandOutcome =
  | { kind: "below_critical"; nextCriticalNoopCounter: 0 }
  /**
   * The cutover was correctly DECLINED (today: a queued operator Stop), not
   * attempted and failed. `nextCriticalNoopCounter` is a PASSTHROUGH of the
   * caller's value — never `+1`. Counting a correct refusal would walk the run
   * toward `compact_unable_at_critical` (`COMPACT_MAX_CONSECUTIVE_NOOPS = 2`)
   * for doing the right thing, so two consecutive deferrals must not escalate.
   */
  | {
      kind: "gate_deferred";
      nextCriticalNoopCounter: number;
      reason: string;
    }
  | {
      kind: "skip_one_shot";
      nextSkipCriticalCheckNextIter: false;
      nextCriticalNoopCounter: number;
    }
  | { kind: "committed"; nextCriticalNoopCounter: 0 }
  | {
      kind: "noop";
      nextCriticalNoopCounter: number;
      reason: string;
    }
  | {
      kind: "escalated";
      stopReason: "compact_unable_at_critical";
      consecutiveNoops: number;
      pressureFraction: number;
    };

export async function tryCriticalBandFallback(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly turnBand: ContextUsageBand;
  readonly skipCriticalCheckNextIter: boolean;
  readonly criticalNoopCounter: number;
  readonly currentTokenCount: number;
  readonly contextLimit: number;
  /** Forwarded to the ladder so a forced apply can prove lease ownership. */
  readonly runnerOwnerId?: string;
  readonly sessionPermission: "restricted" | "full";
  /** Test seams for the shared ladder; production passes neither. */
  readonly criticalCompactionOverrides?: Pick<
    CriticalCompactionInput,
    "readPreparationState" | "sleep"
  >;
}): Promise<CriticalBandOutcome> {
  // Below-critical: noop counter resets the moment band drops out of
  // critical — even if the drop is caused by something other than a
  // compact (e.g. long tool output archived elsewhere). Codex contract.
  if (args.turnBand !== "critical") {
    return { kind: "below_critical", nextCriticalNoopCounter: 0 };
  }

  // One-shot skip: token count is still pre-compact stale; let the next
  // executeTurn refresh it via provider response before re-evaluating.
  if (args.skipCriticalCheckNextIter) {
    return {
      kind: "skip_one_shot",
      nextSkipCriticalCheckNextIter: false,
      nextCriticalNoopCounter: args.criticalNoopCounter,
    };
  }

  // The shared ladder: prepared apply → bounded wait → deterministic fallback.
  // Both critical paths in the loop go through it, so they cannot diverge.
  const outcome = await resolveCriticalCompaction({
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    sessionPermission: args.sessionPermission,
    ...(args.runnerOwnerId === undefined ? {} : { runnerOwnerId: args.runnerOwnerId }),
    ...args.criticalCompactionOverrides,
  });

  if (outcome.kind === "committed") {
    return { kind: "committed", nextCriticalNoopCounter: 0 };
  }

  if (outcome.kind === "deferred") {
    // PASSTHROUGH — see `gate_deferred`'s doc. The escalation block below stays
    // reachable ONLY via genuine noops.
    return {
      kind: "gate_deferred",
      nextCriticalNoopCounter: args.criticalNoopCounter,
      reason: outcome.reason,
    };
  }

  // Noop path — increment counter, log, maybe escalate.
  const nextCriticalNoopCounter = args.criticalNoopCounter + 1;
  logger.warn("compact.forced_fallback.noop", {
    sessionId: args.sessionId,
    reason: outcome.reason,
    consecutiveCount: nextCriticalNoopCounter,
  });

  if (nextCriticalNoopCounter < COMPACT_MAX_CONSECUTIVE_NOOPS) {
    return {
      kind: "noop",
      nextCriticalNoopCounter,
      reason: outcome.reason,
    };
  }

  // Escalation: paused_error → error log → BUG emit, IN THIS ORDER.
  // Caller sets `stopReason` and breaks the loop; everything else
  // happens here so the emit-sequence stays bit-for-bit identical.
  //
  // The status write is GUARDED. `maybeRunForcedCompactFallback` above is an
  // await that can span a whole compaction, and an operator Stop can land
  // terminally inside it — the iteration guards at the top of the loop had
  // already passed by then. An unconditional write would re-open a `stopped`
  // run and replace the canonical `stopped` / `user_stopped` with
  // `paused_error`, erasing what the user actually asked for; a terminal run
  // row is immutable audit history. `updateStatusIfNotTerminal` is a CAS in
  // the WHERE clause, so it holds under concurrency, and a `false` return is
  // the useful signal that this escalation was superseded.
  //
  // The write also carries the DURABLE STOP CONSUMER (full rationale in
  // `runner/mission-auto-retry.ts`): this escalation parks the run with no wake,
  // so a `stop_terminal` queued a moment ago would have no later reader. ONLY
  // the status write moves inside the lock — the `status_superseded` warn, the
  // `logger.error` and the bug emit below keep their placement and
  // conditionality bit-for-bit.
  const missionRunId = args.missionRunId;
  if (missionRunId) {
    const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
      "@vex-agent/engine/runtime/lease-and-status.js"
    );
    const outcome = await withSessionControlLock(args.sessionId, async (client) => {
      const gate = await gateOnOperatorStopWithClient(client, {
        sessionId: args.sessionId,
        missionRunId,
      });
      // Fail-closed: a stopped run gets no park write at all.
      if (gate.kind === "stopped") return "stop_consumed" as const;
      const flipped = await missionRunsRepo.updateStatusIfNotTerminal(
        missionRunId,
        "paused_error",
        "compact_unable_at_critical",
        undefined,
        client,
      );
      return flipped ? ("flipped" as const) : ("superseded" as const);
    });
    if (outcome === "stop_consumed") {
      logger.info("compact.unable_at_critical.consumed_operator_stop", {
        sessionId: args.sessionId,
        missionRunId,
      });
    } else if (outcome === "superseded") {
      logger.warn("compact.unable_at_critical.status_superseded", {
        sessionId: args.sessionId,
        missionRunId,
      });
    }
  }
  logger.error("compact.unable_at_critical", {
    sessionId: args.sessionId,
    consecutiveNoops: nextCriticalNoopCounter,
  });
  const pressure = pressureFraction(args.currentTokenCount, args.contextLimit);
  await emitCompactUnableAtCriticalBug({
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    consecutiveNoops: nextCriticalNoopCounter,
    pressureFraction: pressure,
    stopReason: "compact_unable_at_critical",
  });
  return {
    kind: "escalated",
    stopReason: "compact_unable_at_critical",
    consecutiveNoops: nextCriticalNoopCounter,
    pressureFraction: pressure,
  };
}
