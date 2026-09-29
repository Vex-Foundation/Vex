/**
 * Runner leases repo — exclusive per-session runner ownership (puzzle 03).
 *
 * One runner per session at a time, across the seven continuation entry
 * points (chat / mission start / setup / recover / retry / approval
 * resume / wake-triggered resume). The lease handle (in
 * `engine/runtime/lease-handle.ts`) owns the heartbeat timer + release
 * lifecycle; this repo just exposes the DB primitives.
 *
 * Race-safe claim: `INSERT ... ON CONFLICT (session_id) DO UPDATE
 * WHERE expired OR (same owner AND same claim token)` - the PK uniqueness
 * closes the race between two concurrent first claimants (one INSERT wins,
 * the other folds into the conflict path and re-checks).
 *
 * Claim tokens (migration 173). Every NEW claim - a first insert or a
 * takeover of an expired lease - mints a fresh random `claim_token`. The
 * token, not the owner id, identifies the holder: renewal, release and
 * fenced writes (`db/lease-fence.ts`) all match `session_id + claim_token`.
 * Owner ids are not unique per claim (several runners use a fixed
 * `retry-<run>` / `wake-executor-<wake>` style id), so matching on the owner
 * let two runners both "hold" one lease.
 *
 * `session_id` is TEXT (matches `sessions.id`).
 */

import { randomUUID } from "node:crypto";
import { queryOne, queryOneWith, executeWith, type Executor } from "../client.js";

export type LeaseProcessKind = "electron_main" | "agent_worker" | "test";

/**
 * A lease row as anyone may read it. Deliberately WITHOUT the claim token:
 * a reader that does not hold the lease (a busy claimant, the control-state
 * emitter, the compaction ownership check) must never learn the token that
 * would let it renew, release or write as the holder.
 */
export interface RunnerLeaseInfo {
  readonly sessionId: string;
  readonly missionRunId: string | null;
  readonly ownerId: string;
  readonly processKind: LeaseProcessKind;
  readonly acquiredAt: Date;
  readonly heartbeatAt: Date;
  readonly expiresAt: Date;
}

/** A lease as its HOLDER sees it: the row plus the token of this claim. */
export interface RunnerLease extends RunnerLeaseInfo {
  readonly claimToken: string;
  /**
   * True when THIS claim replaced an expired claim held under another token -
   * a takeover. The previous holder may have had a tool call in flight whose
   * result never reached the transcript, so the new runner reconciles before
   * its first dispatch (`turn-loop/takeover-reconcile.ts`). Absent/false for a
   * first claim or a refresh.
   */
  readonly tookOver?: boolean;
}

interface RunnerLeaseRow {
  readonly session_id: string;
  readonly mission_run_id: string | null;
  readonly owner_id: string;
  readonly process_kind: LeaseProcessKind;
  readonly acquired_at: Date;
  readonly heartbeat_at: Date;
  readonly expires_at: Date;
}

interface RunnerLeaseRowWithToken extends RunnerLeaseRow {
  readonly claim_token: string;
  /** Present only on `acquireLease`'s RETURNING: the conflict path ran. */
  readonly replaced?: boolean;
}

function mapInfo(r: RunnerLeaseRow): RunnerLeaseInfo {
  return {
    sessionId: r.session_id,
    missionRunId: r.mission_run_id,
    ownerId: r.owner_id,
    processKind: r.process_kind,
    acquiredAt: r.acquired_at,
    heartbeatAt: r.heartbeat_at,
    expiresAt: r.expires_at,
  };
}

function mapHeld(r: RunnerLeaseRowWithToken): RunnerLease {
  return { ...mapInfo(r), claimToken: r.claim_token };
}

/**
 * A claim that went through the conflict path and did NOT keep the presented
 * token replaced somebody else's (expired) claim.
 */
function mapAcquired(r: RunnerLeaseRowWithToken, presented: string | undefined): RunnerLease {
  const tookOver = r.replaced === true && r.claim_token !== presented;
  return { ...mapHeld(r), ...(tookOver ? { tookOver: true } : {}) };
}

/** A fresh claim token. Random and unguessable; never derived from the owner id. */
export function newClaimToken(): string {
  return randomUUID();
}

export interface AcquireInput {
  readonly sessionId: string;
  readonly missionRunId?: string | null;
  readonly ownerId: string;
  readonly processKind: LeaseProcessKind;
  readonly ttlMs: number;
  /**
   * The token of a claim the caller ALREADY holds, presented to refresh it.
   * Omit for a new claim. A same-owner call without the current token while
   * the lease is live is refused exactly like a different owner's call.
   */
  readonly claimToken?: string;
}

/**
 * Atomically acquire (or refresh) the lease for `sessionId`.
 *
 * - Brand-new lease (no row): INSERT wins with a NEW token.
 * - Refresh (same owner AND the current token presented): conflict path
 *   UPDATEs heartbeat + expires_at + mission_run_id and KEEPS the token.
 * - Stale lease (current `expires_at < NOW()`): conflict path takes over,
 *   rewrites owner_id and mints a NEW token, so the previous holder's token
 *   stops matching and it can no longer renew, release or write.
 * - Otherwise (live, and not the presented token - including the same
 *   owner id with no or a wrong token): RETURNING is empty - caller
 *   observes `lease_busy` and queries `getLease` for `retryAfterMs`.
 */
export async function acquireLease(
  input: AcquireInput,
  exec?: Executor,
): Promise<RunnerLease | null> {
  const inserted = await queryOneWith<RunnerLeaseRowWithToken>(
    exec ?? (await import("../client.js")).getPool(),
    `INSERT INTO runner_leases
       (session_id, mission_run_id, owner_id, process_kind, acquired_at, heartbeat_at, expires_at, claim_token)
     VALUES ($1, $2, $3, $4, NOW(), NOW(), NOW() + ($5::int * interval '1 millisecond'), $6)
     ON CONFLICT (session_id) DO UPDATE
       SET mission_run_id = EXCLUDED.mission_run_id,
           owner_id       = EXCLUDED.owner_id,
           process_kind   = EXCLUDED.process_kind,
           acquired_at    = NOW(),
           heartbeat_at   = NOW(),
           expires_at     = EXCLUDED.expires_at,
           claim_token    = CASE
                              WHEN runner_leases.owner_id = EXCLUDED.owner_id
                               AND runner_leases.claim_token = $7::text
                              THEN runner_leases.claim_token
                              ELSE EXCLUDED.claim_token
                            END
       WHERE runner_leases.expires_at < NOW()
          OR (runner_leases.owner_id = EXCLUDED.owner_id
              AND runner_leases.claim_token = $7::text)
     RETURNING session_id, mission_run_id, owner_id, process_kind,
               acquired_at, heartbeat_at, expires_at, claim_token,
               (xmax::text <> '0') AS replaced`,
    [
      input.sessionId,
      input.missionRunId ?? null,
      input.ownerId,
      input.processKind,
      input.ttlMs,
      newClaimToken(),
      input.claimToken ?? null,
    ],
  );
  return inserted === null ? null : mapAcquired(inserted, input.claimToken);
}

export { leaseBlocksClaim } from "./runner-lease-rules.js";

/** Refresh the heartbeat + expires_at of the lease held under `claimToken`. */
export async function renewLease(
  sessionId: string,
  claimToken: string,
  ttlMs: number,
  exec?: Executor,
): Promise<RunnerLease | null> {
  const row = await queryOneWith<RunnerLeaseRowWithToken>(
    exec ?? (await import("../client.js")).getPool(),
    `UPDATE runner_leases
       SET heartbeat_at = NOW(),
           expires_at   = NOW() + ($3::int * interval '1 millisecond')
     WHERE session_id  = $1
       AND claim_token = $2
     RETURNING session_id, mission_run_id, owner_id, process_kind,
               acquired_at, heartbeat_at, expires_at, claim_token`,
    [sessionId, claimToken, ttlMs],
  );
  return row === null ? null : mapHeld(row);
}

/**
 * Release the lease held under `claimToken`. Idempotent - returns
 * rowsAffected. If the lease has already been taken over (a new claim
 * minted a new token), the WHERE clause skips the DELETE.
 */
export async function releaseLease(
  sessionId: string,
  claimToken: string,
  exec?: Executor,
): Promise<number> {
  return executeWith(
    exec ?? (await import("../client.js")).getPool(),
    `DELETE FROM runner_leases WHERE session_id = $1 AND claim_token = $2`,
    [sessionId, claimToken],
  );
}

/** Read-only - current lease for a session (or null). Never carries the token. */
export async function getLease(
  sessionId: string,
  exec?: Executor,
): Promise<RunnerLeaseInfo | null> {
  const sql = `SELECT session_id, mission_run_id, owner_id, process_kind,
                      acquired_at, heartbeat_at, expires_at
               FROM runner_leases
               WHERE session_id = $1`;
  const row = exec
    ? await queryOneWith<RunnerLeaseRow>(exec, sql, [sessionId])
    : await queryOne<RunnerLeaseRow>(sql, [sessionId]);
  return row === null ? null : mapInfo(row);
}
