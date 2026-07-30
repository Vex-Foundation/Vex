/**
 * Post-batch handling for `waiting_for_wake` engine signal. Extracted
 * from `turn-loop.ts` for scaling.
 *
 * Ordering matters and is preserved bit-for-bit:
 *
 *   1. Read fresh session token count (best-effort).
 *   2. If the fresh band is `critical`, run the SHARED critical-compaction
 *      ladder before waiting (prepared apply → bounded wait → deterministic
 *      fallback). On committed compact, call `handlePostCompactBookkeeping`
 *      (caller-provided callback because it closes over the loop's
 *      mutable state). On noop, proceed with stale state — the next
 *      resume will see critical and re-evaluate.
 *   3. Flip `mission_runs` status to `paused_wake` with
 *      `waiting_for_wake` stop reason (mission run only).
 *
 * The mission run stays in `running` until the fallback finishes —
 * keeps a concurrent wake claim (status='paused_wake' lookup) or
 * user preempt from racing the compact rewrite of the transcript.
 */

import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { resolveCriticalCompaction } from "./critical-compaction.js";
import { computeBand } from "./context-band.js";
import logger from "@utils/logger.js";

export async function applyWaitingForWakePostBatch(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly currentTokenCount: number;
  readonly contextLimit: number;
  /** Forwarded to the ladder so a forced apply can prove lease ownership. */
  readonly runnerOwnerId?: string;
  readonly sessionPermission: "restricted" | "full";
  readonly handlePostCompactBookkeeping: () => Promise<void>;
}): Promise<void> {
  const freshSession = await sessionsRepo.getSession(args.sessionId);
  const tokenCountAtWait = freshSession?.tokenCount ?? args.currentTokenCount;
  if (computeBand(tokenCountAtWait, args.contextLimit) === "critical") {
    // The SAME ladder the proactive critical path runs — prepared apply first,
    // bounded wait, then the deterministic fallback. Parking with a ready
    // preparation unapplied would strand the session at critical until the wake
    // fires, which can be hours.
    const outcome = await resolveCriticalCompaction({
      sessionId: args.sessionId,
      missionRunId: args.missionRunId,
      sessionPermission: args.sessionPermission,
      ...(args.runnerOwnerId === undefined
        ? {}
        : { runnerOwnerId: args.runnerOwnerId }),
    });
    if (outcome.kind === "committed") {
      await args.handlePostCompactBookkeeping();
    }
  }
  const { sessionId, missionRunId } = args;
  if (missionRunId === null) return;

  // DURABLE STOP CONSUMER (full rationale in `runner/mission-auto-retry.ts`).
  // Parking is the last iteration boundary this run reaches until the wake
  // fires, so a `stop_terminal` queued a moment ago has no other reader. Gate +
  // park commit together under the session control lock.
  //
  // TERMINAL-STOP PRECEDENCE. Parking for a wake is a RECOVERY write — it
  // never moves a run TO terminal — so it goes through the repo CAS. The
  // window here is unusually wide: the forced-compaction await above can span
  // a whole compaction, and an operator Stop landing inside it would be
  // overwritten AND the run re-opened into a resumable state the wake
  // executor would later pick up.
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const outcome = await withSessionControlLock(sessionId, async (client) => {
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId,
    });
    // Fail-closed: a stopped run gets no park write at all.
    if (gate.kind === "stopped") return "stop_consumed" as const;
    const parked = await missionRunsRepo.updateStatusIfNotTerminal(
      missionRunId,
      "paused_wake",
      "waiting_for_wake",
      undefined,
      client,
    );
    return parked ? ("parked" as const) : ("superseded" as const);
  });
  if (outcome === "stop_consumed") {
    logger.info("engine.mission.wake_pause_consumed_operator_stop", {
      sessionId,
      runId: missionRunId,
    });
  } else if (outcome === "superseded") {
    logger.warn("engine.mission.pause_after_terminal", {
      sessionId,
      runId: missionRunId,
      pauseStatus: "paused_wake",
    });
  }
}
