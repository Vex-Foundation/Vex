/**
 * Approval runtime — continuation lifecycle.
 *
 * `claimResumeContinuation` produces a `PreparedContinuation` via the
 * lease-and-status helper (`paused_approval → running` flip + lease
 * acquisition in one tx). `runResumeAfterDecision` consumes it exactly
 * once (lease released in finally). `discardContinuation` is the
 * idempotent fallback when the caller cannot schedule.
 *
 * Codex puzzle-5 phase-3 review point 1 — lease ownership lives end-to-end
 * in this module so prepare callers cannot leak it.
 */

import type { TurnResult } from "../../types.js";
import logger from "@utils/logger.js";
import { LEASE_TTL_MS } from "./helpers.js";
import type { PreparedContinuation } from "./types.js";

export async function claimResumeContinuation(
  sessionId: string,
  missionRunId: string,
  ownerId: string,
): Promise<PreparedContinuation | null> {
  const { claimRunLeaseAndFlipToRunning } = await import(
    "../../runtime/lease-and-status.js"
  );
  const claim = await claimRunLeaseAndFlipToRunning({
    sessionId,
    missionRunId,
    fromStatuses: ["paused_approval", "running"],
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    logger.warn("engine.approval_runtime.lease_busy", {
      sessionId,
      missionRunId,
      ownerId,
    });
    return null;
  }
  if (claim.outcome === "status_mismatch") {
    logger.warn("engine.approval_runtime.status_mismatch", {
      sessionId,
      missionRunId,
      ownerId,
      currentStatus: claim.currentStatus,
    });
    return null;
  }
  const { createLeaseHandle } = await import(
    "../../runtime/lease-handle.js"
  );
  const leaseHandle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  return { missionRunId, sessionId, leaseHandle, ownerId };
}

/**
 * Run the resumed mission-run turn loop. Owns lease release in its finally
 * block. MUST be called at most once per `PreparedContinuation`; if the
 * caller cannot schedule, call `discardContinuation` instead.
 */
export async function runResumeAfterDecision(
  cont: PreparedContinuation,
): Promise<TurnResult> {
  try {
    const { resumeMissionRun } = await import("../runner/mission.js");
    return await resumeMissionRun(cont.missionRunId, cont.leaseHandle.signal);
  } finally {
    const { releaseLeaseAndEmitControlState } = await import(
      "../../runtime/release-and-emit.js"
    );
    await releaseLeaseAndEmitControlState(cont.leaseHandle, cont.sessionId, {
      missionRunId: cont.missionRunId,
    });
  }
}

/**
 * Idempotent lease release for callers that cannot schedule the
 * continuation (process shutdown, dispatch helper failure). The underlying
 * `LeaseHandle.release` is itself idempotent, so double-call is safe.
 */
export async function discardContinuation(
  cont: PreparedContinuation,
): Promise<void> {
  const { releaseLeaseAndEmitControlState } = await import(
    "../../runtime/release-and-emit.js"
  );
  await releaseLeaseAndEmitControlState(cont.leaseHandle, cont.sessionId, {
    missionRunId: cont.missionRunId,
  });
}
