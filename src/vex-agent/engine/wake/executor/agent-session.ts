/**
 * Session-scoped wake handling — the continuation of a Full-Autonomous AGENT
 * session whose runtime slice was exhausted.
 *
 * Why this is not `claimed.ts` with an `if`: the mission path claims by RUN
 * STATUS (`paused_wake → running`, atomically with the run lease). An agent
 * session has no `mission_runs` row at all, so there is no status to CAS and no
 * run to re-check for drift. The exclusion that matters here is the SESSION
 * LEASE — exactly the one `processAgentTurn` takes — so a wake can never
 * interleave with a user turn the operator started in the meantime.
 *
 * ## A lost lease must not lose the continuation
 *
 * `claimDue` is destructive: by the time this function runs, the row is already
 * `consumed` and cannot go back to `pending`. A mission run survives that
 * because the RUN ROW is independent durable evidence — it stays `paused_wake`,
 * visible to the operator and to `/retry`. An agent session has no second
 * record. Consuming the row and returning `skipped_claim_lost` therefore threw
 * the continuation away, permanently and silently.
 *
 * The assumption that made it look safe — "whoever holds the lease IS the
 * continuation" — is false. Approval resume, the end-of-turn hook and the
 * reconciler all take the session lease for work that has nothing to do with
 * this wake, and every one of them releases without continuing the slice.
 *
 * So a lease-busy claim RE-SCHEDULES: a fresh pending row with bounded
 * exponential backoff and an attempt counter in the payload. That is the
 * repo-native shape (`enqueueAutoRetryWake` does the same for error retries).
 * It is enqueue-not-unclaim because the one-way `pending → consumed` transition
 * is a schema invariant, and re-opening it would break the exactly-once claim
 * every other reader depends on.
 *
 * The retry is UNBOUNDED by design. An attempt cap was tried and rejected: a
 * cap is a terminal ceiling by another name, and under full autonomy there are
 * no ceilings — recording an abandonment does not preserve autonomy, it just
 * documents its loss. Only the DELAY is bounded (60 s), and there is no runaway
 * risk because the partial unique index already permits exactly ONE pending row
 * per session: a retry cannot grow the queue, only move the one row's due time.
 *
 * What ends the retry loop is a real event, never a counter:
 *   - the lease is released and the slice runs;
 *   - the operator stops the session — the re-schedule goes through
 *     `scheduleAgentSessionContinuation`, whose gate consumes a session-scoped
 *     stop under the session control lock, so a stopped session gets no row;
 *   - the user sends a message and ingress cancels the pending wake.
 *
 * Preempt safety is unchanged: the ingress router cancels pending wakes before
 * persisting a new user message, so a re-scheduled row loses to a real user
 * turn exactly as the original would have.
 */

import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import {
  scheduleAgentSessionContinuation,
  type ContinuableRuntimeStop,
} from "../../core/runner/runtime-continuation.js";

import type { WakeDeps } from "./deps.js";
import type { ClaimedWakeOutcome } from "./tick.js";

const LEASE_TTL_MS = 5 * 60_000;

/**
 * Backoff for a wake that lost the session lease. The DELAY is capped; the
 * number of attempts deliberately is not — see the module header.
 */
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

/**
 * The trigger this wake was scheduled for, recovered from the structured
 * payload so a re-schedule keeps saying the truth about WHICH bound was
 * exhausted. Never parsed from `reason` — that text is model-adjacent and must
 * not drive control flow.
 */
function readTrigger(wake: LoopWakeRequest): ContinuableRuntimeStop {
  return wake.payload?.trigger === "timeout" ? "timeout" : "iteration_limit";
}

function readAttempt(wake: LoopWakeRequest): number {
  const attempt = wake.payload?.attempt;
  return typeof attempt === "number" && Number.isFinite(attempt) && attempt > 0
    ? attempt
    : 0;
}

export async function handleAgentSessionClaimed(
  wake: LoopWakeRequest,
  deps: WakeDeps,
): Promise<ClaimedWakeOutcome> {
  const ownerId = `wake-executor-${wake.id}`;
  const { claimSessionLease } = await import(
    "../../runtime/lease-and-status.js"
  );
  const claim = await claimSessionLease({
    sessionId: wake.sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs: LEASE_TTL_MS,
  });
  if (claim.outcome === "lease_busy") {
    return rescheduleAfterLeaseBusy(wake);
  }

  const { createLeaseHandle } = await import("../../runtime/lease-handle.js");
  const handle = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: LEASE_TTL_MS,
  });
  try {
    await deps.injectWakeBanner(wake.sessionId, wake.reason, wake.dueAt);
    await deps.continueAgentSession(wake.sessionId);
    return { kind: "agent_session_continued", sessionId: wake.sessionId };
  } finally {
    await releaseLeaseAndEmitControlState(handle, wake.sessionId);
  }
}

async function rescheduleAfterLeaseBusy(
  wake: LoopWakeRequest,
): Promise<ClaimedWakeOutcome> {
  const attempt = readAttempt(wake) + 1;
  const trigger = readTrigger(wake);
  const delayMs = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);

  const rescheduled = await scheduleAgentSessionContinuation({
    sessionId: wake.sessionId,
    trigger,
    attempt,
    delayMs,
  });

  // Telemetry only. The attempt count is carried so a stuck session is
  // DIAGNOSABLE, never so it can be given up on.
  logger.info("wake.executor.agent_session_lease_busy_rescheduled", {
    wakeId: wake.id,
    sessionId: wake.sessionId,
    attempt,
    delayMs,
    scheduled: rescheduled.scheduled,
  });
  return {
    kind: "rescheduled_lease_busy",
    sessionId: wake.sessionId,
    attempt,
    dueAt: rescheduled.dueAt,
    scheduled: rescheduled.scheduled,
  };
}
