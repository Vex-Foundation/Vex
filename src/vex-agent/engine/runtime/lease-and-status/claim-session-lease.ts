/**
 * `claimSessionLease` — atomic per-session lease claim for chat-only
 * flow (no mission_run_id). Uses the same INSERT ... ON CONFLICT
 * primitive but inside its own single-statement transaction so two
 * rapid `chat.submit` IPC calls can't fork the turn loop.
 */

import type { PoolClient } from "pg";
import { withTransaction, queryOneWith } from "../../../db/client.js";
import { acquireLease } from "../../../db/repos/runner-leases.js";
import type {
  ClaimSessionLeaseInput,
  ClaimSessionLeaseOutcome,
} from "./_types.js";
import { type RunnerLeaseRow, mapLease } from "./_row-shapes.js";

/**
 * ACQUIRE ROOT #1 of two. Every ordinary session-lease caller routes through
 * here, so this is where the acquire event is published — AFTER the transaction
 * commits, so the renderer's refetch always finds the lease it was told about.
 *
 * Without it the push spine announced lease RELEASE and never lease ACQUIRE, so
 * the only push-triggered read of the control state landed microseconds after
 * `leaseActive` went false: the sampling was biased to "idle" by construction,
 * and a whole background slice could run with the renderer serving a cached
 * `false`. `emitSessionControlState` is total, so this cannot fail a claim.
 *
 * The OTHER root is the atomic session-wake claim, which acquires the lease
 * with a supplied client and therefore cannot route through here — it publishes
 * its own acquire event after its own commit.
 */
export async function claimSessionLease(
  input: ClaimSessionLeaseInput,
): Promise<ClaimSessionLeaseOutcome> {
  const outcome = await withTransaction((client) =>
    claimSessionLeaseWithClient(client, input));
  if (outcome.outcome === "claimed") {
    const { emitSessionControlState } = await import(
      "../emit-control-state.js"
    );
    await emitSessionControlState(input.sessionId);
  }
  return outcome;
}

/**
 * Same claim, joined to a transaction the CALLER already owns.
 *
 * Exists for the atomic session-wake claim, which must take the session control
 * lock, revalidate the wake row and acquire this lease as ONE commit. Routing
 * that through `claimSessionLease` would open a second transaction and reopen
 * exactly the consume→claim window the atomic protocol removes.
 *
 * The caller owns the lock order: this function takes only the `runner_leases`
 * row lock, so it must be invoked after the session control lock, never before.
 */
export async function claimSessionLeaseWithClient(
  client: PoolClient,
  input: ClaimSessionLeaseInput,
): Promise<ClaimSessionLeaseOutcome> {
  // Lock existing lease (if any) first so we can return its
  // `expires_at` for `retryAfterMs` on busy.
  const existingLease = await queryOneWith<RunnerLeaseRow>(
    client,
    `SELECT session_id, mission_run_id, owner_id, process_kind,
            acquired_at, heartbeat_at, expires_at
       FROM runner_leases
      WHERE session_id = $1
      FOR UPDATE`,
    [input.sessionId],
  );
  if (
    existingLease !== null
    && existingLease.expires_at >= new Date()
    && existingLease.owner_id !== input.ownerId
  ) {
    return { outcome: "lease_busy", currentLease: mapLease(existingLease) };
  }

  const lease = await acquireLease(
    {
      sessionId: input.sessionId,
      ownerId: input.ownerId,
      processKind: input.processKind,
      ttlMs: input.ttlMs,
    },
    client,
  );
  if (lease === null) {
    throw new Error(
      "claimSessionLease: lease upsert returned null despite passing validation",
    );
  }
  return { outcome: "claimed", lease };
}
