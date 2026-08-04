/**
 * `emitSessionControlState` — publish the session's current control state.
 *
 * ## Why this is its own module
 *
 * The emit body used to live inside `releaseLeaseAndEmitControlState`, which
 * meant the renderer was told about lease RELEASE and never about lease
 * ACQUIRE. The consequence was not a missing nicety: the renderer refetches
 * `runtime.getState` when a control-state event arrives, so during ordinary
 * autonomous work every push-triggered read landed microseconds after
 * `leaseActive` went false. The sampling was biased to "idle" BY CONSTRUCTION,
 * and the next slice ran with no event, no invalidation and a cached `false`.
 *
 * It cannot be named `release-and-emit.*`: `release-and-emit-chokepoint.test.ts`
 * asserts that nothing else releases a lease. This module releases nothing —
 * it only publishes — so the chokepoint is untouched.
 *
 * ## TOTAL by contract
 *
 * Never throws, for any reason, including its own reads. Every caller invokes
 * it from a path whose real work has already committed; a failed notification
 * must cost at most a stale renderer until the next event or the 60 s net.
 * Callers therefore do not branch on it and it returns `void`.
 *
 * ## AFTER the commit, always
 *
 * A visible event must always correspond to a state a reader can fetch. Emitted
 * before the commit, the renderer's refetch can win the race and observe the
 * state the event was announcing the end of.
 */

import logger from "@utils/logger.js";
import { getActiveRunBySession, getRun } from "../../db/repos/mission-runs.js";
import { getLease } from "../../db/repos/runner-leases.js";
import { CONTROL_STATE_EVENT_TYPE, controlStateBus } from "./control-bus.js";

export interface EmitSessionControlStateOptions {
  /**
   * Mission run id the caller was working on. When provided the emit prefers
   * `getRun(runId)` over `getActiveRunBySession(sessionId)` so it references
   * the terminated run even after the active-run lookup window closes
   * (`completed`/`cancelled`/etc. are excluded from active-run filters).
   */
  readonly missionRunId?: string | null;
  readonly correlationId?: string | null;
}

export async function emitSessionControlState(
  sessionId: string,
  options: EmitSessionControlStateOptions = {},
): Promise<void> {
  try {
    const lease = await getLease(sessionId);
    let run: Awaited<ReturnType<typeof getRun>> | null = null;
    if (options.missionRunId) {
      run = await getRun(options.missionRunId);
    }
    if (run === null) {
      run = await getActiveRunBySession(sessionId);
    }

    const leaseActive = lease !== null && lease.expiresAt >= new Date();
    controlStateBus.emit({
      type: CONTROL_STATE_EVENT_TYPE,
      sessionId,
      missionRunId: run?.id ?? options.missionRunId ?? null,
      runStatus: run?.status ?? null,
      stopReason: run?.stopReason ?? null,
      pendingControlKind: null,
      leaseActive,
      leaseExpiresAt: leaseActive ? lease.expiresAt.toISOString() : null,
      correlationId: options.correlationId ?? null,
    });
  } catch (err) {
    logger.warn("runtime.emit_control_state.failed", {
      sessionId,
      missionRunId: options.missionRunId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
