/**
 * `releaseLeaseAndEmitControlState` — post-release emit helper
 * (puzzle 03, codex review acceptance criterion).
 *
 * Every lease-owning runner entry point MUST call this in its
 * `finally` block instead of `handle.release()` directly. The helper:
 *
 *   1. Releases the lease (idempotent, swallowing).
 *   2. Re-reads canonical state from DB (active mission run + lease).
 *   3. Emits `controlStateBus` with the post-release payload so the
 *      renderer observes the lease transition from active → inactive
 *      and the runner's final mission_run status (e.g. `cancelled`
 *      after a `stopped` finalize).
 *   4. Fires the end-of-turn approval resume hook.
 *
 * The function is fail-closed — any read/emit error is swallowed.
 * Runtime callers must not branch on its outcome; the release itself
 * is the only behavior that must succeed (handled by `handle.release`).
 *
 * WHY STEP 4 LIVES HERE AND NOT AT THE CALL SITES. It used to be a line each
 * caller added after calling this helper, and that is a rule you cannot keep:
 * five sites had it, five more did not, and the missing ones were found one at
 * a time by review rather than by anything mechanical. The trigger is not
 * "a turn ended" — it is "this session's lease is free again", because that is
 * the exact condition an approval decision defers on (`claimResumeContinuation`
 * reports `busy` for ANY lease holder, a three-line prepare-abort included).
 * That condition is this function, so this function owns the hook. A future
 * lease-release site now gets the sub-500 ms resume by construction, and
 * `release-and-emit-chokepoint.test.ts` pins that no lease is released
 * anywhere else.
 *
 * Three things were checked before centralising it, all of them the reasons a
 * blanket hook could have been wrong:
 *
 *   IT CANNOT RUN AWAY. The hook is fire-and-forget, and the pass it starts
 *   never runs concurrently with another for the same session: a hook arriving
 *   mid-pass queues exactly ONE coalesced follow-up instead. That follow-up is
 *   required — a pass reads its eligible rows once, so an approval decided
 *   after that read is invisible to it — and it terminates because eligibility
 *   ends at `resume_consumed_at`, written before the release, so the release
 *   performed BY a resume leads to a pass that finds nothing.
 *
 *   IT CANNOT RESUME A RUN THE USER STOPPED. The suppression paths that
 *   deliberately drop a continuation (`discardContinuation` after an operator
 *   Stop) leave the run in a terminal or paused status, and a resume claim only
 *   accepts `APPROVAL_RESUME_CLAIMABLE_RUN_STATUSES` (`running`,
 *   `paused_approval`). Chat sessions have no such suppression path at all —
 *   `applyQueuedOperatorStop` returns `clear` when there is no run.
 *
 *   IT CANNOT FAIL A TURN. Every caller invokes this from a `finally`;
 *   `dispatchPendingApprovalResumesAfterRelease` swallows everything, including
 *   its own dynamic import.
 *
 * The hook is imported dynamically so `runtime/` keeps no static edge into
 * `core/approval-runtime/`, which reaches back into the runners.
 */

import logger from "@utils/logger.js";
import { getActiveRunBySession, getRun } from "../../db/repos/mission-runs.js";
import { getLease } from "../../db/repos/runner-leases.js";
import {
  CONTROL_STATE_EVENT_TYPE,
  controlStateBus,
} from "./control-bus.js";
import type { LeaseHandle } from "./lease-handle.js";

export interface ReleaseAndEmitOptions {
  /**
   * Mission run id the caller was working on. When provided the helper
   * prefers `getRun(runId)` over `getActiveRunBySession(sessionId)` so
   * the emit references the terminated run even after the active-run
   * lookup window closes (`completed`/`cancelled`/etc. are excluded
   * from active-run filters in some queries).
   */
  readonly missionRunId?: string | null;
  readonly correlationId?: string | null;
}

export async function releaseLeaseAndEmitControlState(
  handle: LeaseHandle,
  sessionId: string,
  options: ReleaseAndEmitOptions = {},
): Promise<void> {
  // Release first — this is the only side effect callers depend on.
  await handle.release();

  try {
    const lease = await getLease(sessionId);
    let run: Awaited<ReturnType<typeof getRun>> | null = null;
    if (options.missionRunId) {
      run = await getRun(options.missionRunId);
    }
    if (run === null) {
      run = await getActiveRunBySession(sessionId);
    }

    controlStateBus.emit({
      type: CONTROL_STATE_EVENT_TYPE,
      sessionId,
      missionRunId: run?.id ?? options.missionRunId ?? null,
      runStatus: run?.status ?? null,
      stopReason: run?.stopReason ?? null,
      pendingControlKind: null,
      leaseActive: lease !== null && lease.expiresAt >= new Date(),
      leaseExpiresAt:
        lease !== null && lease.expiresAt >= new Date()
          ? lease.expiresAt.toISOString()
          : null,
      correlationId: options.correlationId ?? null,
    });
  } catch (err) {
    logger.warn("runtime.release_and_emit.read_failed", {
      sessionId,
      missionRunId: options.missionRunId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // STRICTLY after the release above — see this file's header and
  // `end-of-turn-resume-hook.ts`. Outside the try/catch on purpose: a failed
  // control-state read must not cost the session its fast resume.
  try {
    const { dispatchPendingApprovalResumesAfterRelease } = await import(
      "../core/approval-runtime/end-of-turn-resume-hook.js"
    );
    await dispatchPendingApprovalResumesAfterRelease(sessionId);
  } catch (err) {
    // The hook swallows its own failures; this guards only the dynamic import
    // of the hook module itself. A `finally` caller must never inherit a throw
    // from here.
    logger.warn("runtime.release_and_emit.resume_hook_unavailable", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
