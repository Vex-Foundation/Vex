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
 * ## The claim is atomic, so the continuation cannot be lost
 *
 * The row is no longer consumed before the lease is claimed. Revalidation,
 * lease acquisition and the `pending → consumed` flip commit together under the
 * session control lock (`claim-session-wake.ts`), which removes the window in
 * which a session had neither a pending wake nor a lease — the window in which
 * an operator Stop found nothing to stop, and in which a lost lease threw the
 * continuation away.
 *
 * A lease-busy claim therefore no longer needs a replacement row: the SAME
 * pending row is simply pushed out by the bounded backoff. The retry stays
 * unbounded by design — see the claim module for the full rationale.
 *
 * Preempt safety is unchanged: the ingress router cancels pending wakes before
 * persisting a new user message, so a deferred row loses to a real user turn
 * exactly as the original would have.
 */

import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";

import type { WakeDeps } from "./deps.js";
import type { ClaimedWakeOutcome } from "./tick.js";

const LEASE_TTL_MS = 5 * 60_000;

export async function handleAgentSessionClaimed(
  wake: LoopWakeRequest,
  deps: WakeDeps,
  now: Date,
): Promise<ClaimedWakeOutcome> {
  const ownerId = `wake-executor-${wake.id}`;
  const claim = await deps.claimSessionWake({
    wake,
    ownerId,
    ttlMs: LEASE_TTL_MS,
    now,
  });

  if (claim.kind === "not_claimable") {
    logger.info("wake.executor.agent_session_not_claimable", {
      wakeId: wake.id,
      sessionId: wake.sessionId,
    });
    return { kind: "skipped_claim_lost" };
  }

  if (claim.kind === "lease_busy") {
    // Telemetry only. The attempt count is carried so a stuck session is
    // DIAGNOSABLE, never so it can be given up on.
    logger.info("wake.executor.agent_session_lease_busy_deferred", {
      wakeId: wake.id,
      sessionId: wake.sessionId,
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
    await deps.continueAgentSession(wake.sessionId, ownerId);
    return { kind: "agent_session_continued", sessionId: wake.sessionId };
  } finally {
    await releaseLeaseAndEmitControlState(handle, wake.sessionId);
  }
}
