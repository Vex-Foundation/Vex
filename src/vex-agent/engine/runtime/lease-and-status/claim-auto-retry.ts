/**
 * `claimRunForAutoRetry` — the AUTO-RETRY-only resume claim (Phase 4d).
 *
 * Distinct from `claimRunLeaseAndFlipToRunning` (manual Recover, which is
 * allowed even when the run is unsafe). This claim is the real authority: it
 * re-verifies the ENTIRE safety state under a single row lock before flipping
 * to `running`, defeating the race where a human Recover mutates + stamps
 * unsafe + fails back to `paused_error` after the wake was scheduled. The wake
 * executor runs it inside its own atomic claim (`claimRunForAutoRetryWith`),
 * so the wake row is consumed only when this claim succeeds.
 *
 * ALL predicates must hold (else `ineligible`, no flip):
 *   - run exists and belongs to `sessionId`
 *   - status === "paused_error"
 *   - auto_retry_unsafe === false
 *   - stop_reason === "provider_error"
 *   - error_retry_count === expectedAttempt   (epoch guard)
 *   - live sessions.permission === "full"
 *   - the frozen snapshot still opts in
 *
 * One commit; no inter-statement race window.
 */

import type { PoolClient } from "pg";

import {
  withTransaction,
  queryOneWith,
  executeWith,
} from "../../../db/client.js";
import { acquireLease } from "../../../db/repos/runner-leases.js";
import type {
  LeaseProcessKind,
  RunnerLease,
  RunnerLeaseInfo,
} from "../../../db/repos/runner-leases.js";
import { snapshotAutoRetryEnabled } from "../../core/runner/mission-auto-retry-policy.js";
import {
  type RunnerLeaseRow,
  mapLease,
  LOCK_LEASE_COLUMNS,
  lockedLeaseBlocks,
} from "./_row-shapes.js";

export interface ClaimAutoRetryInput {
  readonly sessionId: string;
  readonly missionRunId: string;
  /** The attempt the wake was scheduled for; must equal error_retry_count. */
  readonly expectedAttempt: number;
  readonly ownerId: string;
  readonly processKind: LeaseProcessKind;
  readonly ttlMs: number;
  /** Token of a claim the caller already holds (refresh only); omit for a new claim. */
  readonly claimToken?: string;
}

export type AutoRetryIneligibleReason =
  | "run_missing"
  | "session_mismatch"
  | "status_changed"
  | "unsafe"
  | "stop_reason"
  | "attempt_mismatch"
  | "not_full"
  | "opt_out";

export type ClaimAutoRetryOutcome =
  | { readonly outcome: "claimed"; readonly lease: RunnerLease }
  | { readonly outcome: "lease_busy"; readonly currentLease: RunnerLeaseInfo }
  | { readonly outcome: "ineligible"; readonly reason: AutoRetryIneligibleReason };

interface AutoRetryClaimRow {
  readonly status: string;
  readonly session_id: string;
  readonly stop_reason: string | null;
  readonly error_retry_count: number;
  readonly auto_retry_unsafe: boolean;
  readonly contract_snapshot_json: Record<string, unknown> | null;
  readonly permission: string;
}

export async function claimRunForAutoRetry(
  input: ClaimAutoRetryInput,
): Promise<ClaimAutoRetryOutcome> {
  return withTransaction((client) => claimRunForAutoRetryWith(client, input));
}

/**
 * The same claim on a transaction the CALLER owns. The wake executor needs the
 * wake row's consumption, the safety re-check, the flip and the lease in ONE
 * commit under the session control lock; the caller owns that lock order.
 * Nothing here writes before every predicate has passed.
 */
export async function claimRunForAutoRetryWith(
  client: PoolClient,
  input: ClaimAutoRetryInput,
): Promise<ClaimAutoRetryOutcome> {
  {
    // 1. Lock the run row + read its full safety state + live session permission.
    const row = await queryOneWith<AutoRetryClaimRow>(
      client,
      `SELECT mr.status, mr.session_id, mr.stop_reason, mr.error_retry_count,
              mr.auto_retry_unsafe, mr.contract_snapshot_json, s.permission
         FROM mission_runs mr
         JOIN sessions s ON s.id = mr.session_id
        WHERE mr.id = $1
        FOR UPDATE OF mr`,
      [input.missionRunId],
    );

    // 2. Re-verify EVERY safety predicate under the lock (fail-closed).
    if (row === null) return { outcome: "ineligible", reason: "run_missing" };
    if (row.session_id !== input.sessionId) {
      return { outcome: "ineligible", reason: "session_mismatch" };
    }
    if (row.status !== "paused_error") {
      return { outcome: "ineligible", reason: "status_changed" };
    }
    if (row.auto_retry_unsafe === true) {
      return { outcome: "ineligible", reason: "unsafe" };
    }
    if (row.stop_reason !== "provider_error") {
      return { outcome: "ineligible", reason: "stop_reason" };
    }
    if (row.error_retry_count !== input.expectedAttempt) {
      return { outcome: "ineligible", reason: "attempt_mismatch" };
    }
    if (row.permission !== "full") {
      return { outcome: "ineligible", reason: "not_full" };
    }
    if (!snapshotAutoRetryEnabled(row.contract_snapshot_json)) {
      return { outcome: "ineligible", reason: "opt_out" };
    }

    // 3. Lock + validate the lease row (absent / expired / same-owner).
    const existingLease = await queryOneWith<RunnerLeaseRow>(
      client,
      `SELECT ${LOCK_LEASE_COLUMNS}
         FROM runner_leases
        WHERE session_id = $1
        FOR UPDATE`,
      [input.sessionId],
    );
    if (
      existingLease !== null
    && lockedLeaseBlocks(existingLease, input.ownerId, input.claimToken)
    ) {
      return { outcome: "lease_busy", currentLease: mapLease(existingLease) };
    }

    // 4. Flip to running + acquire/refresh the lease in the same tx. No wake
    //    cleanup: the wake executor consumes the causing error_retry wake in
    //    this same transaction, and a paused_error run never has a pending
    //    continuation wake to cancel.
    await executeWith(
      client,
      `UPDATE mission_runs
          SET status = 'running', last_checkpoint_at = NOW()
        WHERE id = $1`,
      [input.missionRunId],
    );
    const lease = await acquireLease(
      {
        sessionId: input.sessionId,
        missionRunId: input.missionRunId,
        ownerId: input.ownerId,
        processKind: input.processKind,
        ttlMs: input.ttlMs,
        claimToken: input.claimToken,
      },
      client,
    );
    if (lease === null) {
      throw new Error(
        "claimRunForAutoRetry: lease upsert returned null despite passing validation",
      );
    }
    return { outcome: "claimed", lease };
  }
}
