import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { MissionRun } from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";

import type { WakeDeps } from "./deps.js";
import type { ClaimedWakeOutcome } from "./tick.js";

/**
 * Phase 4d auto-retry resume. The wake was scheduled for a `paused_error` run;
 * `claimRunForAutoRetry` re-verifies the ENTIRE safety state under a row lock
 * (status, unsafe stamp, stop_reason, attempt epoch, live full-mode permission,
 * snapshot opt-in) before flipping to running — so a human Recover that mutated
 * + stamped unsafe between claimDue and here makes this claim skip.
 */
export async function handleAutoRetryClaimed(
  wake: LoopWakeRequest,
  run: MissionRun,
  deps: WakeDeps,
): Promise<ClaimedWakeOutcome> {
  if (run.status !== "paused_error") {
    logger.info("wake.executor.auto_retry_skip_stale", {
      wakeId: wake.id,
      runId: run.id,
      status: run.status,
    });
    return { kind: "skipped_stale_status", currentStatus: run.status };
  }

  const attempt =
    typeof wake.payload?.attempt === "number" ? wake.payload.attempt : -1;
  const ownerId = `auto-retry-${wake.id}`;
  const { claimRunForAutoRetry } = await import(
    "../../runtime/lease-and-status.js"
  );
  const claim = await claimRunForAutoRetry({
    sessionId: wake.sessionId,
    missionRunId: run.id,
    expectedAttempt: attempt,
    ownerId,
    processKind: "electron_main",
    ttlMs: 5 * 60_000,
  });
  if (claim.outcome === "lease_busy") {
    logger.info("wake.executor.auto_retry_skip_lease_busy", {
      wakeId: wake.id,
      runId: run.id,
    });
    return { kind: "skipped_claim_lost" };
  }
  if (claim.outcome === "ineligible") {
    // A human Recover / terminal transition / opt-out / attempt drift won the
    // race; the consumed wake is dropped without resuming.
    logger.info("wake.executor.auto_retry_ineligible", {
      wakeId: wake.id,
      runId: run.id,
      reason: claim.reason,
    });
    return { kind: "skipped_claim_lost" };
  }

  const { createLeaseHandle } = await import("../../runtime/lease-handle.js");
  const handle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: 5 * 60_000,
  });
  try {
    await deps.injectWakeBanner(wake.sessionId, wake.reason, wake.dueAt);
    await deps.resumeMissionRun(run.id, handle.signal);
    return { kind: "resumed", runId: run.id };
  } finally {
    const { releaseLeaseAndEmitControlState } = await import(
      "../../runtime/release-and-emit.js"
    );
    await releaseLeaseAndEmitControlState(handle, wake.sessionId, {
      missionRunId: run.id,
    });
  }
}
