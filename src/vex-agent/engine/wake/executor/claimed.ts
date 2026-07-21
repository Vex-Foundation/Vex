import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import { AUTO_RETRY_WAKE_TRIGGER } from "../../core/runner/mission-auto-retry-policy.js";
import logger from "@utils/logger.js";

import type { WakeDeps } from "./deps.js";
import type { ClaimedWakeOutcome } from "./tick.js";
import { handleAutoRetryClaimed } from "./auto-retry.js";

export async function handleClaimed(
  wake: LoopWakeRequest,
  deps: WakeDeps,
): Promise<ClaimedWakeOutcome> {
  const run = await deps.getMissionRun(wake.missionRunId);
  if (!run) {
    return { kind: "skipped_mission_run_missing" };
  }

  // Phase 4d: error-retry wakes resume a `paused_error` run through the
  // auto-retry claim (which re-verifies the full safety state). Routed by the
  // structured payload trigger, NOT the model-influenced `reason` text.
  if (wake.payload?.trigger === AUTO_RETRY_WAKE_TRIGGER) {
    return handleAutoRetryClaimed(wake, run, deps);
  }

  // Preempt-before-resume re-check. Only wake a run that is still
  // `paused_wake` — a user message or terminal transition may have
  // already moved it elsewhere while this tick was spooling up.
  if (run.status !== "paused_wake") {
    logger.info("wake.executor.skip_stale", {
      wakeId: wake.id,
      runId: run.id,
      status: run.status,
    });
    return { kind: "skipped_stale_status", currentStatus: run.status };
  }

  // Puzzle 03 — atomic claim lease + flip status in a single tx.
  // Replaces the non-atomic CAS-then-acquireLease that could leave
  // the run as `running` with no runner if the lease acquire failed
  // (codex blocker). Also handles the `paused_wake → consumed_by_resume`
  // wake cleanup inside the same transaction.
  const ownerId = `wake-executor-${wake.id}`;
  const { claimRunLeaseAndFlipToRunning } = await import(
    "../../runtime/lease-and-status.js"
  );
  const claim = await claimRunLeaseAndFlipToRunning({
    sessionId: wake.sessionId,
    missionRunId: run.id,
    fromStatuses: ["paused_wake"],
    ownerId,
    processKind: "electron_main",
    ttlMs: 5 * 60_000,
  });
  if (claim.outcome === "lease_busy") {
    logger.info("wake.executor.skip_lease_busy", {
      wakeId: wake.id,
      runId: run.id,
    });
    return { kind: "skipped_claim_lost" };
  }
  if (claim.outcome === "status_mismatch") {
    logger.info("wake.executor.skip_claim_lost", {
      wakeId: wake.id,
      runId: run.id,
      currentStatus: claim.currentStatus,
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
