/**
 * `/retry` engine entry point.
 *
 * Re-enters the active mission run after a recoverable pause:
 *   - `paused_error` → provider error or other throw inside the runner;
 *     the operator wants to re-attempt once the issue is resolved.
 *   - `paused_wake`  → wake hasn't fired yet; the operator wants to skip
 *     the delay and resume immediately.
 *
 * Refuses (with explicit hint) for:
 *   - `paused_approval` → operator must `/approve` or `/reject` first.
 *   - `running`         → loop already in progress; nothing to retry.
 *   - no active run     → nothing to retry.
 *
 * Race safety (puzzle 03): the lease + status + pending-wake cleanup
 * are committed in a SINGLE `claimRunLeaseAndFlipToRunning` transaction
 * (codex review acceptance). If the claim fails (`lease_busy` /
 * `status_mismatch`) the run + wakes stay untouched, so a failed retry
 * can't strand the session in a partial state.
 */

import type { TurnResult, MissionRunStatus } from "../../types.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import {
  ACTIVE_RUN_STATUSES,
  PAUSED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
} from "../../types.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "@vex-agent/engine/runtime/release-and-emit.js";

const RETRYABLE_FROM_STATUSES: readonly MissionRunStatus[] = [
  "paused_error",
  "paused_wake",
];

export async function retryActiveMissionRun(sessionId: string): Promise<TurnResult> {
  const run = await missionRunsRepo.getActiveRunBySession(sessionId);
  if (!run) {
    throw new Error(
      "No active mission run to retry. Start one with the Start mission button first.",
    );
  }

  if (run.status === "paused_approval") {
    throw new Error(
      "Mission run is awaiting approval. Use /approve <id> or /reject <id> first.",
    );
  }

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new Error(
      `Mission run is ${run.status} and cannot be retried. Start a fresh run.`,
    );
  }

  if (ACTIVE_RUN_STATUSES.has(run.status)) {
    throw new Error("Mission run is already in progress; nothing to retry.");
  }

  if (!PAUSED_RUN_STATUSES.has(run.status)) {
    // Coerced fallback (e.g. the safe-default `failed` from coerceStatus).
    // Surface explicitly rather than silently resume.
    throw new Error(`Mission run is in an unrecognised state (${run.status}).`);
  }

  // Phase 4d: a human Recover supersedes any scheduled auto-retry — cancel the
  // pending error_retry wake so it can't fire later. A wake already CONSUMED by
  // the executor cannot be cancelled; there, `claimRunForAutoRetry`'s atomic
  // re-check (status/unsafe/attempt) is the authority and will skip.
  await loopWakeRepo.cancelForSession(sessionId, "superseded_by_manual_recover");

  // Puzzle 03 — atomic claim lease + flip status in ONE transaction
  // so a concurrent IPC `requestResume` / wake executor can't leave
  // the run in `running` with no runner if our lease acquire later
  // fails (codex blocker: previous CAS-then-acquire-lease was a
  // non-atomic two-step). Single-tx helper also handles the
  // `paused_wake → consumed_by_resume` wake cleanup when applicable.
  const ownerId = `retry-${run.id}`;
  const { claimRunLeaseAndFlipToRunning } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const claim = await claimRunLeaseAndFlipToRunning({
    sessionId,
    missionRunId: run.id,
    fromStatuses: RETRYABLE_FROM_STATUSES,
    ownerId,
    processKind: "electron_main",
    ttlMs: 5 * 60_000,
  });
  if (claim.outcome === "lease_busy") {
    throw new Error(
      "Mission run lease was claimed by another runner. Re-check status with /status.",
    );
  }
  if (claim.outcome === "status_mismatch") {
    throw new Error(
      "Mission run was claimed by another resumer. Re-check status with /status.",
    );
  }

  logger.info("engine.retry.flipped_to_running", {
    sessionId,
    runId: run.id,
    previousStatus: claim.previousStatus,
    wakeCancelledCount: claim.wakeCancelledCount,
  });

  const { createLeaseHandle } = await import(
    "@vex-agent/engine/runtime/lease-handle.js"
  );
  const handle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: 5 * 60_000,
  });
  try {
    // Lazy import to break the runner ↔ retry circular dependency.
    const { resumeMissionRun } = await import("./mission.js");
    return await resumeMissionRun(run.id, ownerId);
  } finally {
    await releaseLeaseAndEmitControlState(handle, sessionId, {
      missionRunId: run.id,
    });
    // A retried run releases the same session lease every other turn does, so
    // an approval resolved while it was running resumes via the end-of-turn
    // hook inside the helper above rather than on the retry ladder.
  }
}
