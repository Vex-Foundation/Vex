/**
 * Runner lease guard - what a lease-holding runner threads into its turn loop
 * so the loop can (a) fence its writes on the claim and (b) notice that the
 * claim is gone.
 *
 * ## `lostSignal` is NOT the operator Stop
 *
 * The Stop signal is handed to tools and means "the user asked this run to
 * end". Lease loss means "another runner owns this session now", and it must
 * never reach a tool: an in-flight dispatch (a signature, a broadcast) always
 * settles. The loop reads `lostSignal` only to (1) start no NEW dispatch,
 * (2) abort the current INFERENCE call, and (3) end the turn with the distinct
 * `lease_lost` stop reason. Where both fire, Stop wins everywhere, so a Stop
 * is never reported as anything else.
 *
 * ## Reasons
 *
 * - `taken_over`  - another claim's token is on the lease row. Every later
 *                   fenced write is refused locally, without a round trip.
 * - `released`    - the row is gone (released, or deleted by an operator
 *                   Stop's transaction). No new dispatch; closing writes still
 *                   go to the DB fence, which permits a released lease.
 * - `unconfirmed` - the heartbeat's renewal failed and the follow-up read
 *                   could not say why. No new dispatch; writes are left to
 *                   the DB fence, which decides authoritatively.
 */

import logger from "@utils/logger.js";
import {
  logFencedWriteRefused,
  readLeaseFenceState,
  withLeaseFence,
  type LeaseFence,
  type LeaseFenceOutcome,
  type LeaseFenceSite,
} from "../../db/lease-fence.js";
import type { PoolClient } from "pg";

export type LeaseLostReason = "taken_over" | "released" | "unconfirmed";

/** Which mechanism noticed the loss. Bounded enum for the log. */
export type LeaseLostSource = "heartbeat" | "fence" | "dispatch_check";

export interface RunnerLeaseGuard {
  /** Owner id the claim was made under (the compaction ownership proof). */
  readonly ownerId: string;
  /** The claim fenced writes are conditional on. */
  readonly fence: LeaseFence;
  /**
   * This claim replaced an expired claim of another runner (a takeover). The
   * turn loop reconciles the session's unresolved money state before its
   * first dispatch when it is set.
   */
  readonly tookOverExpiredClaim: boolean;
  /**
   * Aborts once this runner's claim is known to be lost. Distinct from, and
   * never combined into, the Stop signal a tool receives.
   */
  readonly lostSignal: AbortSignal;
  /** The first recorded loss reason, or null while the claim is believed held. */
  lostReason(): LeaseLostReason | null;
  /** Idempotent; only the first call records a reason, logs and aborts. */
  markLost(reason: LeaseLostReason, source: LeaseLostSource): void;
}

export function createRunnerLeaseGuard(input: {
  readonly ownerId: string;
  readonly fence: LeaseFence;
  readonly tookOverExpiredClaim?: boolean;
  readonly onLost?: (reason: LeaseLostReason) => void;
}): RunnerLeaseGuard {
  const controller = new AbortController();
  let reason: LeaseLostReason | null = null;
  return {
    ownerId: input.ownerId,
    fence: input.fence,
    tookOverExpiredClaim: input.tookOverExpiredClaim === true,
    lostSignal: controller.signal,
    lostReason: () => reason,
    markLost(next, source) {
      if (reason !== null) return;
      reason = next;
      logger.warn("runtime.lease.lost", {
        sessionId: input.fence.sessionId,
        reason: next,
        source,
      });
      controller.abort();
      if (input.onLost !== undefined) {
        try {
          input.onLost(next);
        } catch (cbErr) {
          logger.warn("runner_lease.handle.on_lost_callback_threw", {
            sessionId: input.fence.sessionId,
            errorClass: cbErr instanceof Error ? cbErr.constructor.name : typeof cbErr,
          });
        }
      }
    },
  };
}

/** True once the guard's claim is known lost (any reason). */
export function isLeaseLost(guard: RunnerLeaseGuard | undefined): boolean {
  return guard !== undefined && guard.lostSignal.aborted;
}

/**
 * A fenced write on behalf of a runner. Refused locally (no DB round trip)
 * once the claim is known taken over; otherwise the DB fence decides, and a
 * DB refusal marks the guard lost so the loop stops at its next check.
 * Never throws for a refusal.
 */
export async function guardedWrite<T>(
  guard: RunnerLeaseGuard,
  site: LeaseFenceSite,
  fn: (client: PoolClient) => Promise<T>,
  opts: { readonly lockMissionRunId?: string } = {},
): Promise<LeaseFenceOutcome<T>> {
  if (guard.lostReason() === "taken_over") {
    logFencedWriteRefused(guard.fence, site, "known_lost");
    return { fenced: false, state: "taken_over" };
  }
  const outcome = await withLeaseFence(guard.fence, fn, {
    site,
    ...(opts.lockMissionRunId === undefined
      ? {}
      : { lockMissionRunId: opts.lockMissionRunId }),
  });
  if (!outcome.fenced) guard.markLost("taken_over", "fence");
  return outcome;
}

/**
 * Pre-dispatch token check: may this runner start a NEW tool call? Only a
 * lease row carrying our token says yes. Any other answer marks the guard
 * lost. A failed read is NOT a loss - the call is allowed and the write fence
 * still guards its result - because a transient DB error must not turn into a
 * silently dropped tool call.
 */
export async function leaseHeldForDispatch(
  guard: RunnerLeaseGuard,
): Promise<boolean> {
  if (guard.lostSignal.aborted) return false;
  let state;
  try {
    state = await readLeaseFenceState(guard.fence);
  } catch (err) {
    logger.warn("runtime.lease.dispatch_check_failed", {
      sessionId: guard.fence.sessionId,
      errorClass: err instanceof Error ? err.constructor.name : typeof err,
    });
    return true;
  }
  if (state === "held") return true;
  guard.markLost(state, "dispatch_check");
  return false;
}
