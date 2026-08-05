/**
 * The ATOMIC session-scoped wake claim.
 *
 * ## What it replaces, and why the old shape could not be patched
 *
 * The previous protocol was two independent steps: a destructive batch
 * `claimDue` (`pending → consumed`) followed by a separate `claimSessionLease`
 * transaction. Between them a session had NEITHER a pending wake NOR a lease,
 * so every durable fact about the continuation was false at once — an operator
 * Stop landing there found nothing to stop, and a lease-busy claim had already
 * destroyed the row. That was compensated for by enqueueing a REPLACEMENT row
 * with backoff, which is a second write racing the thing it compensates for.
 *
 * Here the claim is ONE transaction, in the canonical lock order:
 *
 *   1. `acquireSessionControlLock(client, sessionId)` — FIRST, which is only
 *      possible because the candidate read already told us WHICH session this
 *      is. A single batch statement cannot take a per-session lock; that is the
 *      whole reason the non-destructive candidate read precedes it.
 *   2. re-read and lock the specific wake row, revalidating that it is still
 *      `pending` and still due. An operator Stop cancels pending wakes under
 *      this same lock, so a Stop that committed first revalidates to nothing
 *      here and no slice starts.
 *   3. acquire the SESSION LEASE on the same client.
 *   4. consume the row ONLY on a successful lease acquisition.
 *
 * On LEASE BUSY nothing is consumed. The SAME row's `due_at` is pushed out by
 * the bounded backoff and its attempt metadata incremented, in this same
 * transaction. The backoff POLICY is carried over verbatim from the deleted
 * replacement-row implementation: 5 s base, doubling, 60 s cap, and UNBOUNDED
 * attempts — the retry is unbounded by design, only the DELAY is bounded, and
 * there is no runaway risk because the partial unique index already permits
 * exactly ONE pending row per session, so a retry can only move that row's due
 * time.
 *
 * What ends the retry loop is a real event, never a counter: the lease is
 * released and the slice runs; the operator stops the session (the stop cancels
 * the pending wake under this lock); or the user sends a message and ingress
 * cancels the wake.
 */

import type { LoopWakeRequest } from "@vex-agent/db/repos/loop-wake.js";
import type { RunnerLease } from "@vex-agent/db/repos/runner-leases.js";

/** Backoff for a wake that lost the session lease — DELAY only, never attempts. */
export const SESSION_WAKE_RETRY_BASE_MS = 5_000;
export const SESSION_WAKE_RETRY_MAX_MS = 60_000;

export type ClaimSessionWakeOutcome =
  /** The row is consumed AND this owner holds the session lease. */
  | { readonly kind: "claimed"; readonly lease: RunnerLease }
  /**
   * Unrelated work holds the session lease. The row is STILL PENDING with a
   * pushed-out `due_at`; nothing was lost.
   */
  | {
      readonly kind: "lease_busy";
      readonly attempt: number;
      readonly dueAt: string;
    }
  /**
   * The row stopped being claimable under the lock — cancelled by an operator
   * Stop or ingress preempt, or claimed by another executor.
   */
  | { readonly kind: "not_claimable" };

export interface ClaimSessionWakeInput {
  readonly wake: LoopWakeRequest;
  readonly ownerId: string;
  readonly ttlMs: number;
  readonly now: Date;
}

/**
 * Attempt metadata recovered from the structured payload. Never parsed from
 * `reason` — that text is model-adjacent and must not drive control flow.
 */
function readAttempt(wake: LoopWakeRequest): number {
  const attempt = wake.payload?.attempt;
  return typeof attempt === "number" && Number.isFinite(attempt) && attempt > 0
    ? attempt
    : 0;
}

export function backoffDelayMs(attempt: number): number {
  return Math.min(
    SESSION_WAKE_RETRY_BASE_MS * 2 ** (attempt - 1),
    SESSION_WAKE_RETRY_MAX_MS,
  );
}

export async function claimSessionWakeAtomically(
  input: ClaimSessionWakeInput,
): Promise<ClaimSessionWakeOutcome> {
  const { withTransaction } = await import("@vex-agent/db/client.js");
  const loopWakeRepo = await import("@vex-agent/db/repos/loop-wake.js");
  const { acquireSessionControlLock, claimSessionLeaseWithClient } =
    await import("../../runtime/lease-and-status.js");

  const outcome = await withTransaction(
    async (client): Promise<ClaimSessionWakeOutcome> => {
      await acquireSessionControlLock(client, input.wake.sessionId);

      const locked = await loopWakeRepo.lockDueSessionScopedWith(
        client,
        input.wake.id,
        input.now,
      );
      if (locked === null) return { kind: "not_claimable" };

      const claim = await claimSessionLeaseWithClient(client, {
        sessionId: locked.sessionId,
        ownerId: input.ownerId,
        processKind: "electron_main",
        ttlMs: input.ttlMs,
      });
      if (claim.outcome === "lease_busy") {
        const attempt = readAttempt(locked) + 1;
        const dueAt = new Date(input.now.getTime() + backoffDelayMs(attempt));
        await loopWakeRepo.deferLockedWith(client, locked.id, dueAt, attempt);
        return { kind: "lease_busy", attempt, dueAt: dueAt.toISOString() };
      }

      await loopWakeRepo.consumeLockedWith(client, locked.id);
      return { kind: "claimed", lease: claim.lease };
    },
  );

  // ACQUIRE ROOT #2 of two, AFTER the commit. This primitive acquires the lease
  // with its own client, so it cannot route through `claimSessionLease` and
  // must publish its own acquire event — otherwise a wake-driven slice starts
  // with nothing telling the renderer the session is live again, and the
  // cached "idle" stands for the whole slice. `emitSessionControlState` is
  // total, so this cannot fail a claim that already committed.
  if (outcome.kind === "claimed") {
    const { emitSessionControlState } = await import(
      "../../runtime/emit-control-state.js"
    );
    await emitSessionControlState(input.wake.sessionId);
  }
  return outcome;
}
