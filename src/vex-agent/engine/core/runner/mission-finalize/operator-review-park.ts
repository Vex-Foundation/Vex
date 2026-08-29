/**
 * No-wake operator-review park for `compact_unable_at_critical` and
 * `no_progress`.
 *
 * PR2 cutover: the runtime escalates to `compact_unable_at_critical` when
 * the forced-fallback compact returns `noop` twice in a row at critical
 * band - the agent cannot make forward progress without compaction it
 * refuses to perform. Treat as a paused error (operator intervention
 * surface) rather than a hard "failed" finalisation: the run row stays
 * visible for /retry just like provider-error pauses, and the parent
 * mission row stays `running` so the active-run lookup still surfaces it.
 *
 * TERMINAL-STOP PRECEDENCE. This is the LAST write in the escalation chain,
 * so it - not the turn-loop helper that decided to escalate - is what the run
 * row ends up carrying. The decision itself is arbitrarily stale by the time
 * it lands here: `maybeRunForcedCompactFallback` is an await that can span a
 * whole forced compaction, and an operator Stop can land terminally at any
 * point inside it, INCLUDING after the helper's own CAS already succeeded.
 * Guarding only the earlier write is therefore not enough - whichever write
 * is last decides, so every write in the chain goes through the one repo CAS
 * that owns this invariant (`updateStatusIfNotTerminal`). The unconditional
 * `updateStatus` is reserved for writes that legitimately move a run TO a
 * terminal state; a park/recovery write must never move one back out. A
 * terminal user stop outranks every other terminal state.
 *
 * `no_progress` shares this arm's shape exactly: a run that cannot make
 * forward progress on its own, parked for operator review with NO wake.
 * It must NOT fall through to the caller's `return "running"` default - that
 * would leave the run row `running` with no wake and no lease, an orphan the
 * operator can neither resume nor see the reason for. It is equally not a
 * continuable stop: an unproductive round persists nothing, so a scheduled
 * continuation would re-ask the identical question (see `stop-conditions.ts`).
 */

import type { MissionStatus } from "../../../types.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";

export type OperatorReviewParkStop =
  | "compact_unable_at_critical"
  | "no_progress";

export async function finalizeOperatorReviewPark(
  missionId: string,
  runId: string,
  sessionId: string,
  stopReason: OperatorReviewParkStop,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
): Promise<MissionStatus> {
  // DURABLE STOP CONSUMER (see `mission-auto-retry.ts` for the full
  // rationale). Parking here reaches `paused_error` with NO wake, so this is
  // the last iteration boundary the run will ever have: a `stop_terminal`
  // request still queued at this point would be stranded until the operator
  // clicked Stop a second time. Gate + park commit together under the
  // session control lock so a Stop cannot slip between them.
  const defaultSummary = stopReason === "no_progress"
    ? "The model returned only empty responses - no answer and no tool call - for several consecutive rounds; operator review required."
    : "Two consecutive forced-fallback noops at critical pressure - operator review required.";
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "../../../runtime/lease-and-status.js"
  );
  const parked = await withSessionControlLock(sessionId, async (client) => {
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId: runId,
    });
    // Fail-closed: the gate only COMPLETES the stop; it never resumes or
    // dispatches anything. A stopped run gets no park write at all.
    if (gate.kind === "stopped") return false;
    return missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      "paused_error",
      stopReason,
      {
        summary: stopPayload?.summary ?? defaultSummary,
        evidence: stopPayload?.evidence,
      },
      client,
    );
  });
  if (!parked) {
    // The run reached a terminal status while the compaction was awaited -
    // in practice an operator Stop, whose own transaction already set the
    // mission row. Nothing was written here and nothing may be: a terminal
    // run row is immutable audit history. The return value describes what
    // THIS arm did to the mission row (nothing, on both branches), which is
    // why it is unchanged; the warn log is the record that the escalation
    // was superseded.
    logger.warn("engine.mission.operator_review_park_after_terminal", {
      runId,
      missionId,
      sessionId,
      stopReason,
    });
  }
  return "running";
}
