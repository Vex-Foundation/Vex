/**
 * Iteration-entry outcome reduction — turns the discriminated outcome of
 * `runIterationEntryGuards` into the turn loop's next step.
 *
 * Extracted verbatim from `turn-loop.ts`. The guard helper decides; this file
 * owns what the loop DOES with each verdict (canonical control emit, stop
 * reason, post-compact bookkeeping, fall-through logging), which is a distinct
 * reason to change from the loop's own state threading.
 *
 * Evaluation order is contract and mirrors the guard's own order: abort →
 * control-pause → control-stop → runtime stop → compaction outcomes.
 */

import type { StopReason } from "../../types.js";
import logger from "@utils/logger.js";
import type { IterationEntryOutcome } from "../turn-loop-iteration-entry.js";
import { emitTurnLoopControlState } from "../turn-loop-control-emit.js";

/**
 * `stop` ⇒ the caller sets `stopReason` and breaks. `proceed` ⇒ the caller runs
 * the turn. Both compaction outcomes are `proceed`: neither is a stop, and
 * skipping the turn for either would be a defect — a deferral repeats for as
 * long as the money state is unresolved, and that state usually clears only
 * BECAUSE the agent keeps running (an approval dispatches, a broadcast
 * confirms). Skipping would spin the loop to `iteration_limit` waiting for
 * something only the skipped turn could cause. This mirrors the forced
 * fallback's `committed` arm, which also runs bookkeeping and proceeds.
 */
export type IterationEntryStep =
  | { readonly kind: "stop"; readonly stopReason: StopReason }
  | { readonly kind: "proceed" };

export async function applyIterationEntryOutcome(args: {
  readonly entry: IterationEntryOutcome;
  readonly sessionId: string;
  /**
   * Non-null whenever a `control_*` outcome is reachable (those only arise for
   * mission runs), which is why the emit below asserts it — same assertion the
   * loop made inline before this extraction.
   */
  readonly missionRunId: string | null;
  readonly handlePostCompactBookkeeping: () => Promise<void>;
}): Promise<IterationEntryStep> {
  const { entry } = args;

  if (entry.kind === "abort_user_stopped") {
    return { kind: "stop", stopReason: "user_stopped" };
  }
  if (entry.kind === "control_paused_user") {
    await emitTurnLoopControlState(
      args.sessionId,
      args.missionRunId!,
      "paused_user",
      "user_paused",
      entry.correlationId,
    );
    return { kind: "stop", stopReason: "user_paused" };
  }
  if (entry.kind === "control_stopped") {
    await emitTurnLoopControlState(
      args.sessionId,
      args.missionRunId!,
      "stopped",
      "user_stopped",
      entry.correlationId,
    );
    return { kind: "stop", stopReason: "user_stopped" };
  }
  if (entry.kind === "runtime_stop") {
    return { kind: "stop", stopReason: entry.stopReason };
  }

  if (entry.kind === "compaction_applied") {
    // The transcript was rewritten under us. The same bookkeeping the forced
    // fallback runs re-reads the live messages, the new summary and the reset
    // token count, so this turn plans against the compacted session rather
    // than the stale one the loop was holding.
    await args.handlePostCompactBookkeeping();
    logger.info("turn-loop.compaction_applied", {
      sessionId: args.sessionId,
      generation: entry.generation,
      archivedMessages: entry.archivedMessages,
    });
  }
  if (entry.kind === "compaction_apply_deferred") {
    // NOT a failed compaction, and deliberately NOT counted toward
    // `criticalNoopCounter`: the gate deferring for a queued stop or
    // unresolved money state is it working. Counting it would escalate a
    // healthy run to `paused_error` for waiting correctly.
    logger.info("turn-loop.compaction_apply_deferred", {
      sessionId: args.sessionId,
      reasonKinds: entry.reasons.map((r) => r.kind),
    });
  }

  return { kind: "proceed" };
}
