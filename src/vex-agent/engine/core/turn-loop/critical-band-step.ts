/**
 * Critical-band step — observes the turn's band, runs the critical-band forced
 * fallback ladder, and reduces its outcome into the loop's counters.
 *
 * Extracted verbatim from `turn-loop.ts`. `tryCriticalBandFallback` owns the
 * ladder itself (updateStatus → logger.error → bug-emit on escalation, all
 * bit-for-bit preserved); this file owns the caller-side contract of WHICH
 * counter moves on which arm — notably the two arms that must NEVER count a
 * correct refusal toward `criticalNoopCounter`.
 */

import logger from "@utils/logger.js";
import type { BandObserver } from "../turn-loop-state-init.js";
import { tryCriticalBandFallback } from "../turn-loop-critical-fallback.js";

type ObservedBand = ReturnType<BandObserver>;

export type CriticalBandStep =
  | { readonly kind: "stop"; readonly stopReason: "compact_unable_at_critical" }
  | {
      readonly kind: "proceed";
      readonly turnBand: ObservedBand;
      readonly criticalNoopCounter: number;
      readonly skipCriticalCheckNextIter: boolean;
    };

export async function runCriticalBandStep(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly sessionPermission: "restricted" | "full";
  readonly runnerOwnerId: string | undefined;
  readonly contextLimit: number;
  readonly criticalNoopCounter: number;
  readonly skipCriticalCheckNextIter: boolean;
  readonly observeBand: BandObserver;
  /**
   * Read LIVE, not passed by value: `handlePostCompactBookkeeping` resets the
   * loop's token count to 0, and the `committed` arm must re-observe against
   * that new value.
   */
  readonly readCurrentTokenCount: () => number;
  readonly handlePostCompactBookkeeping: () => Promise<void>;
}): Promise<CriticalBandStep> {
  let turnBand = args.observeBand(args.readCurrentTokenCount(), "iteration_start");
  let criticalNoopCounter = args.criticalNoopCounter;
  let skipCriticalCheckNextIter = args.skipCriticalCheckNextIter;

  const criticalOutcome = await tryCriticalBandFallback({
    sessionId: args.sessionId,
    missionRunId: args.missionRunId,
    turnBand,
    skipCriticalCheckNextIter,
    criticalNoopCounter,
    currentTokenCount: args.readCurrentTokenCount(),
    contextLimit: args.contextLimit,
    sessionPermission: args.sessionPermission,
    ...(args.runnerOwnerId === undefined
      ? {}
      : { runnerOwnerId: args.runnerOwnerId }),
  });

  switch (criticalOutcome.kind) {
    case "below_critical":
      criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
      break;
    case "skip_one_shot":
      skipCriticalCheckNextIter = criticalOutcome.nextSkipCriticalCheckNextIter;
      criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
      break;
    case "committed":
      await args.handlePostCompactBookkeeping();
      // Bookkeeping reset `currentTokenCount = 0`, so re-observe to drop
      // turnBand from critical → normal for this turn (P1 #2).
      turnBand = args.observeBand(args.readCurrentTokenCount(), "post_forced_fallback");
      criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
      break;
    case "gate_deferred":
      // PASSTHROUGH counter (never +1). The cutover was declined correctly —
      // today only for a queued operator Stop, which the NEXT iteration
      // guard consumes. Counting it would escalate a healthy run for waiting.
      criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
      logger.info("compact.forced_apply.gate_deferred", {
        sessionId: args.sessionId,
        reason: criticalOutcome.reason,
      });
      break;
    case "noop":
      criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
      break;
    case "escalated":
      return { kind: "stop", stopReason: criticalOutcome.stopReason };
  }

  return {
    kind: "proceed",
    turnBand,
    criticalNoopCounter,
    skipCriticalCheckNextIter,
  };
}
