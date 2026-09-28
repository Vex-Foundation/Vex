import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";

import type { WakeDeps } from "./deps.js";
import type { ClaimedWakeOutcome } from "./tick.js";
import { handleAgentSessionClaimed } from "./agent-session.js";
import { isAutoRetryWake } from "./claim-mission-wake.js";

const LEASE_TTL_MS = 5 * 60_000;

/**
 * Claim ONE listed wake candidate and, if the claim succeeds, run it to the end
 * of its slice before the tick moves to the next candidate.
 *
 * Both shapes are claimed atomically under the session control lock. Nothing is
 * consumed before this call, so a process that dies here leaves every later
 * candidate pending and claimable after restart.
 */
export async function handleClaimed(
  wake: LoopWakeRequest,
  deps: WakeDeps,
  now: Date,
): Promise<ClaimedWakeOutcome> {
  // Session-scoped continuation of a Full-Autonomous agent session. Routed on
  // the row's own shape: there is no run row, and the claim is the session
  // lease rather than a run-status flip.
  if (wake.missionRunId === null) {
    return handleAgentSessionClaimed(wake, deps, now);
  }

  // Phase 4d: an error-retry wake resumes a `paused_error` run through the
  // auto-retry claim, which re-verifies the full safety state under the run
  // lock. Routed by the structured payload trigger, NOT the model-influenced
  // `reason` text. The owner id keeps its historical prefix per route.
  const autoRetry = isAutoRetryWake(wake);
  const ownerId = autoRetry
    ? `auto-retry-${wake.id}`
    : `wake-executor-${wake.id}`;

  const claim = await deps.claimMissionWake({
    wake,
    ownerId,
    ttlMs: LEASE_TTL_MS,
    now,
  });

  if (claim.kind === "not_claimable") {
    logger.info("wake.executor.mission_not_claimable", {
      wakeId: wake.id,
      runId: wake.missionRunId,
    });
    return { kind: "skipped_claim_lost" };
  }

  if (claim.kind === "deferred") {
    logger.info("wake.executor.mission_claim_deferred", {
      wakeId: wake.id,
      runId: wake.missionRunId,
      cause: claim.cause,
      attempt: claim.attempt,
      dueAt: claim.dueAt,
    });
    return {
      kind: "deferred_lease_busy",
      sessionId: wake.sessionId,
      attempt: claim.attempt,
      dueAt: claim.dueAt,
    };
  }

  if (claim.kind === "dropped") {
    logger.info("wake.executor.mission_wake_dropped", {
      wakeId: wake.id,
      runId: wake.missionRunId,
      reason: claim.reason,
      status: claim.currentStatus,
      autoRetry,
    });
    if (claim.reason === "run_missing") {
      return { kind: "skipped_mission_run_missing" };
    }
    if (claim.reason === "auto_retry_ineligible") {
      // A human Recover / terminal transition / opt-out / epoch drift won.
      return { kind: "skipped_claim_lost" };
    }
    return {
      kind: "skipped_stale_status",
      currentStatus: claim.currentStatus ?? "missing",
    };
  }

  const { createLeaseHandle } = await import("../../runtime/lease-handle.js");
  const handle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  try {
    await deps.injectWakeBanner(
      wake.sessionId,
      wake.reason,
      wake.dueAt,
      wake.payload?.triggeredBy,
    );
    await deps.resumeMissionRun(claim.runId, ownerId);
    return { kind: "resumed", runId: claim.runId };
  } finally {
    await releaseLeaseAndEmitControlState(handle, wake.sessionId, {
      missionRunId: claim.runId,
    });
  }
}
