/**
 * Approval runtime — durable deferred resume.
 *
 * A resolved approval must ALWAYS end with the agent being woken to observe the
 * result. The immediate wake (straight after the decision) is only the fastest
 * of four attempts; this module owns the two middle ones, and the scheduled
 * reconciler is the durable floor:
 *
 *   1. immediately after the decision            — `prepare{Approve,Reject}`
 *   2. in-process backoff on a busy lease        — HERE
 *   3. end-of-turn hook when a lease is released — HERE
 *   4. the 5-minute reconciler pass              — `reconcile.ts`
 *
 * This worker handles BOTH shapes an outstanding approval can have, because a
 * decision can stall in either of them:
 *
 *   DECIDED BUT UNDISPATCHED  (`approved` + `not_started`) — the session lease
 *     was busy when the user decided, so the tool has NOT run yet. This is the
 *     ordinary case: the user approves while a turn is still in flight.
 *   DISPATCHED BUT UNRESUMED  (`result_message_id` set, `resume_consumed_at`
 *     null) — the tool ran and its result is recorded; only the wake is
 *     missing.
 *
 * Matching only the second shape was the defect that left the product half
 * fixed: on a busy lease there is no result row, so the backoff retries AND the
 * end-of-turn hook both found zero work and the approval waited out the full
 * five-minute sweep. Both shapes now resolve through the same lease-aware
 * actions the reconciler uses (`lifecycle-actions.ts`).
 *
 * `resumed_at` records attempts and is deliberately NOT consulted — a crash
 * after an attempt was stamped but before the lease-held core began must still
 * recover.
 *
 * Attempt 3 is why chat feels instant rather than eventual: the common case is
 * the user approving while a turn is already running, and the resume fires the
 * moment that turn lets go of the lease instead of waiting for the reconciler.
 * It MUST be invoked strictly after the release, or it self-blocks on the very
 * lease it is trying to claim.
 *
 * Not a polling loop: these are bounded one-shot timers armed only by an
 * observed busy lease, and they disarm themselves once the work is claimed.
 */

import * as approvalIntentsRepo from "../../../db/repos/approval-intents.js";
import logger from "@utils/logger.js";

import { applyResumableLifecycleRow } from "./lifecycle-actions.js";

/**
 * Backoff ladder for a resume that lost the lease race. Short and finite: the
 * point is to cover "the other runner finishes in a moment", not to reimplement
 * the reconciler, which is already the durable answer for everything longer.
 */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000] as const;

/** Sessions with a resume pass currently running in this process. */
const inFlightSessions = new Set<string>();

/**
 * Sessions whose in-flight pass must be followed by exactly ONE fresh pass.
 *
 * A pass works from a single snapshot taken when it started
 * (`getPendingLifecycleForSession`). Anything that becomes eligible after that
 * read is invisible to it, and the in-flight guard makes the hook announcing it
 * a no-op — so the second approval of a burst used to fall through to the
 * 2s/5s/15s ladder, in precisely the case this mechanism exists for: a decision
 * taken while the agent is busy.
 *
 * A SET, not a counter, because a pass scans every eligible row for the session:
 * one fresh pass after the current one already covers any number of arrivals,
 * and N queued passes would differ from one only in doing N-1 empty scans.
 *
 * Termination: a follow-up runs only because an arrival was observed during the
 * previous pass, and eligibility ends at `resume_consumed_at`, stamped before
 * the release that fires the hook. So the chain shortens on its own — the pass
 * that follows the last real arrival finds nothing, marks nothing, and stops.
 */
const pendingRerunSessions = new Set<string>();

/** Sessions with a backoff ladder already armed — never stack two. */
const armedSessions = new Set<string>();

/**
 * Attempt 3 — the end-of-turn hook. Call AFTER the session lease has been
 * released. Fire-and-forget by contract: a turn must never fail because a
 * follow-on resume did.
 */
export function dispatchPendingApprovalResumes(sessionId: string): void {
  void resumePendingApprovalsForSession(sessionId).catch((cause) => {
    logger.warn("engine.approval_runtime.resume_hook_failed", {
      sessionId,
      errorKind: cause instanceof Error ? cause.constructor.name : typeof cause,
    });
  });
}

/**
 * Attempt 2 — arm the in-process backoff ladder after a busy lease was
 * observed. Idempotent per session: a second call while a ladder is armed is a
 * no-op, so a burst of deferred decisions cannot multiply the timers.
 */
export function scheduleDeferredResumeRetries(sessionId: string): void {
  if (armedSessions.has(sessionId)) return;
  armedSessions.add(sessionId);

  let remaining = RETRY_DELAYS_MS.length;
  for (const delayMs of RETRY_DELAYS_MS) {
    const timer = setTimeout(() => {
      void resumePendingApprovalsForSession(sessionId)
        .catch((cause) => {
          logger.warn("engine.approval_runtime.resume_retry_failed", {
            sessionId,
            delayMs,
            errorKind:
              cause instanceof Error ? cause.constructor.name : typeof cause,
          });
        })
        .finally(() => {
          remaining -= 1;
          if (remaining <= 0) armedSessions.delete(sessionId);
        });
    }, delayMs);
    // Never hold the process open for a retry — the reconciler covers anything
    // that outlives this run.
    timer.unref?.();
  }
}

/**
 * Resolve every outstanding approval for one session — dispatching the ones
 * that never ran and waking the agent for the ones that did.
 *
 * Re-entrancy: a call arriving while a pass is running for this session does
 * NOT run concurrently and is NOT dropped — it queues one coalesced follow-up
 * pass (see `pendingRerunSessions`).
 *
 * Sequential and lease-gated by design: each row takes the session lease, runs,
 * and releases before the next is considered. A BUSY claim ends the pass rather
 * than spinning — the lease is session-scoped, so every remaining row would say
 * the same thing, and the later attempt paths exist exactly so this one can give
 * up cheaply.
 *
 * A row whose RUN is not claimable is a different fact and is skipped, not
 * stopped on. It used to end the pass too, because both answers arrived as one
 * `lease_held`: a single approval on a run that had left the claimable statuses
 * (a `paused_error` run, say) therefore blocked every newer approval in the same
 * session for as long as it existed, and the age-ordered scans kept handing it
 * back first. Run status is per-run, and one session can own several runs.
 *
 * Returns the number of rows this pass actually moved forward.
 */
export async function resumePendingApprovalsForSession(
  sessionId: string,
): Promise<number> {
  if (inFlightSessions.has(sessionId)) {
    // Coalesce: the running pass cannot see whatever just became eligible, so
    // record that ONE more pass is owed and let it start when this one ends.
    pendingRerunSessions.add(sessionId);
    return 0;
  }
  inFlightSessions.add(sessionId);
  try {
    const pending =
      await approvalIntentsRepo.getPendingLifecycleForSession(sessionId);
    let handled = 0;

    for (const row of pending) {
      try {
        const outcome = await applyResumableLifecycleRow(row);
        if (outcome === "lease_held") {
          logger.info("engine.approval_runtime.deferred_resume_not_claimed", {
            sessionId,
            approvalId: row.approvalId,
          });
          break;
        }
        // `run_not_resumable` and `noop` both fall through to the next row:
        // neither moved this approval forward, and neither says anything about
        // the rows behind it. `resumeLifecycleRow` already logged the former.
        if (outcome === "dispatched" || outcome === "resumed") handled += 1;
      } catch (cause) {
        // One bad row must not abort the pass for the rest of the session.
        logger.warn("engine.approval_runtime.deferred_resume_threw", {
          sessionId,
          approvalId: row.approvalId,
          errorKind:
            cause instanceof Error ? cause.constructor.name : typeof cause,
        });
      }
    }

    return handled;
  } finally {
    inFlightSessions.delete(sessionId);
    // In `finally`, and after the guard is cleared: an arrival is owed a pass
    // whether or not THIS pass succeeded, and the follow-up must be able to
    // enter. Fire-and-forget — the follow-up's own count is not this pass's
    // return value, and a caller must never wait on it.
    if (pendingRerunSessions.delete(sessionId)) {
      dispatchPendingApprovalResumes(sessionId);
    }
  }
}
