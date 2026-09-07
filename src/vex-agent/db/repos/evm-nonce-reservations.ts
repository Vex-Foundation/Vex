/**
 * Durable EVM nonce allocation across every local signer arm.
 *
 * Agent Scan paths already own a pending `agent_activity` row before signing,
 * so their reservation is written into that row. The legacy Pendle allowance
 * helper has no activity row; migration 091 supplies the narrow reservation
 * table for that one seam. Allocation reads both sources under one Postgres
 * advisory transaction lock and therefore survives process restart.
 */

import type pg from "pg";

import { query, queryOne, queryOneWith, withTransaction } from "../client.js";

export const LEGACY_EVM_NONCE_RESERVATION_STALE_MS = 15 * 60 * 1000;
export const EVM_NONCE_REPAIR_LIMIT = 25;
export const EVM_NONCE_REPAIR_LEASE_MS = 30_000;
export const EVM_NONCE_REPAIR_INTERVAL_MS = 30_000;

export interface EvmNonceReservationRequest {
  readonly fromAddress: string;
  readonly chainId: number;
  readonly nodePendingNonce: number;
}

export interface LegacyEvmNonceReservation {
  readonly id: number;
  readonly nonce: number;
}

export type LegacyEvmNoncePurpose =
  | "pendle_allowance"
  | "lighter_deposit_approve"
  | "lighter_deposit"
  | "lighter_withdrawal_claim";

export type EvmNonceRepairTerminalReason =
  | "mined_success"
  | "mined_revert"
  | "nonce_superseded";

export type EvmNonceRepairInconclusiveReason =
  | "in_mempool"
  | "unknown_to_node"
  | "rpc_error"
  | "unreadable_receipt";

export interface ClaimedEvmNonceReservation {
  readonly id: number;
  readonly chainId: number;
  readonly fromAddress: string;
  readonly nonce: number;
  readonly txHash: string;
  readonly status: "staged" | "accepted";
  readonly claimToken: string;
}

export interface ClaimDueEvmNonceReservationsResult {
  readonly claimed: readonly ClaimedEvmNonceReservation[];
  readonly overflowDue: number;
}

interface ActivityReservationRow extends pg.QueryResultRow {
  readonly id: string;
  readonly chain_id: string;
  readonly chain_family: string;
  readonly wallet_address: string;
  readonly status: string;
  readonly tx_hash: string | null;
  readonly from_address: string | null;
  readonly nonce: string | null;
  readonly evidence_source: string | null;
}

interface HighestNonceRow extends pg.QueryResultRow {
  readonly highest_nonce: string;
}

interface LegacyReservationRow extends pg.QueryResultRow {
  readonly id: string;
  readonly nonce: string;
}

interface ClaimedReservationRow extends pg.QueryResultRow {
  readonly id: string;
  readonly chain_id: string;
  readonly from_address: string;
  readonly nonce: string;
  readonly tx_hash: string;
  readonly status: "staged" | "accepted";
  readonly repair_claim_token: string;
}

function validateRequest(input: EvmNonceReservationRequest): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.fromAddress)) {
    throw new Error("evm nonce reservation: fromAddress is not an EVM address");
  }
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) {
    throw new Error("evm nonce reservation: chainId must be a positive safe integer");
  }
  if (!Number.isSafeInteger(input.nodePendingNonce) || input.nodePendingNonce < 0) {
    throw new Error("evm nonce reservation: nodePendingNonce must be a non-negative safe integer");
  }
  return input.fromAddress.toLowerCase();
}

async function lockWallet(
  client: pg.PoolClient,
  chainId: number,
  normalizedAddress: string,
): Promise<void> {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`vex:evm-nonce:${chainId}:${normalizedAddress}`],
  );
}

async function abandonStaleLegacyReservations(
  client: pg.PoolClient,
  input: EvmNonceReservationRequest,
  normalizedAddress: string,
): Promise<void> {
  await client.query(
    `UPDATE evm_nonce_reservations
        SET status = 'abandoned', terminal_at = NOW(), updated_at = NOW()
      WHERE chain_id = $1 AND lower(from_address) = $2
        AND status = 'reserved' AND tx_hash IS NULL
        AND updated_at < NOW() - make_interval(secs => $3::float8)`,
    [input.chainId, normalizedAddress, LEGACY_EVM_NONCE_RESERVATION_STALE_MS / 1000],
  );
}

async function highestUnresolvedNonce(
  client: pg.PoolClient,
  input: EvmNonceReservationRequest,
  normalizedAddress: string,
  excludedActivityId: number | null,
): Promise<number> {
  const row = await queryOneWith<HighestNonceRow>(
    client,
    `SELECT GREATEST(
       COALESCE((
         SELECT MAX(nonce)
           FROM agent_activity
          WHERE chain_family = 'eip155' AND chain_id = $1
            AND lower(from_address) = $2 AND status = 'pending'
            AND nonce IS NOT NULL AND ($3::bigint IS NULL OR id <> $3::bigint)
       ), -1),
       COALESCE((
         SELECT MAX(nonce)
           FROM evm_nonce_reservations
          WHERE chain_id = $1 AND lower(from_address) = $2
            AND status IN ('reserved', 'staged', 'accepted')
       ), -1)
     )::text AS highest_nonce`,
    [input.chainId, normalizedAddress, excludedActivityId],
  );
  if (row === null) {
    throw new Error("evm nonce reservation: highest nonce query returned no row");
  }
  const highest = Number(row.highest_nonce);
  if (!Number.isSafeInteger(highest) || highest < -1) {
    throw new Error("evm nonce reservation: durable nonce exceeds the supported safe-integer range");
  }
  return highest;
}

function nextNonce(nodePendingNonce: number, highest: number, existing: number | null = null): number {
  const next = Math.max(nodePendingNonce, highest + 1, existing ?? -1);
  if (!Number.isSafeInteger(next) || next < 0) {
    throw new Error("evm nonce reservation: allocated nonce exceeds the supported safe-integer range");
  }
  return next;
}

/** Reserve directly on the pending activity row before any signature exists. */
export async function reserveActivityEvmNonce(
  activityId: number,
  input: EvmNonceReservationRequest,
): Promise<number> {
  if (!Number.isSafeInteger(activityId) || activityId <= 0) {
    throw new Error("evm nonce reservation: activityId must be a positive safe integer");
  }
  const normalizedAddress = validateRequest(input);
  return withTransaction(async (client) => {
    await lockWallet(client, input.chainId, normalizedAddress);
    await abandonStaleLegacyReservations(client, input, normalizedAddress);

    const activity = await queryOneWith<ActivityReservationRow>(
      client,
      `SELECT id::text, chain_id::text, chain_family, wallet_address, status,
              tx_hash, from_address, nonce::text, evidence_source
         FROM agent_activity
        WHERE id = $1
        FOR UPDATE`,
      [activityId],
    );
    if (activity === null) {
      throw new Error("evm nonce reservation: activity row does not exist");
    }
    if (
      activity.status !== "pending"
      || activity.tx_hash !== null
      || activity.chain_family !== "eip155"
      || activity.evidence_source !== null
      || Number(activity.chain_id) !== input.chainId
      || activity.wallet_address.toLowerCase() !== normalizedAddress
      || (activity.from_address !== null && activity.from_address.toLowerCase() !== normalizedAddress)
    ) {
      throw new Error("evm nonce reservation: activity row is not an eligible local EVM signing intent");
    }

    const existing = activity.nonce === null ? null : Number(activity.nonce);
    if (existing !== null && (!Number.isSafeInteger(existing) || existing < 0)) {
      throw new Error("evm nonce reservation: existing activity nonce is outside the safe-integer range");
    }
    const highest = await highestUnresolvedNonce(client, input, normalizedAddress, activityId);
    const nonce = nextNonce(input.nodePendingNonce, highest, existing);
    const updated = await queryOneWith<{ readonly nonce: string }>(
      client,
      `UPDATE agent_activity
          SET from_address = $2, nonce = $3, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
          AND chain_family = 'eip155' AND evidence_source IS NULL
        RETURNING nonce::text`,
      [activityId, normalizedAddress, nonce],
    );
    if (updated === null || Number(updated.nonce) !== nonce) {
      throw new Error("evm nonce reservation: activity reservation CAS missed");
    }
    return nonce;
  });
}

/** Reserve for the one active local signer seam that has no activity row. */
export async function reserveLegacyEvmNonce(
  input: EvmNonceReservationRequest,
  purpose: LegacyEvmNoncePurpose,
): Promise<LegacyEvmNonceReservation> {
  const normalizedAddress = validateRequest(input);
  return withTransaction(async (client) => {
    await lockWallet(client, input.chainId, normalizedAddress);
    await abandonStaleLegacyReservations(client, input, normalizedAddress);
    const highest = await highestUnresolvedNonce(client, input, normalizedAddress, null);
    const nonce = nextNonce(input.nodePendingNonce, highest);
    const row = await queryOneWith<LegacyReservationRow>(
      client,
      `INSERT INTO evm_nonce_reservations (
         chain_id, from_address, nonce, purpose
       ) VALUES ($1, $2, $3, $4)
       RETURNING id::text, nonce::text`,
      [input.chainId, normalizedAddress, nonce, purpose],
    );
    if (row === null) {
      throw new Error("evm nonce reservation: insert returned no row");
    }
    return { id: Number(row.id), nonce: Number(row.nonce) };
  });
}

export async function stageLegacyEvmNonce(
  reservationId: number,
  input: { readonly txHash: string; readonly fromAddress: string; readonly nonce: number },
): Promise<void> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) {
    throw new Error("evm nonce reservation: staged transaction hash is invalid");
  }
  const row = await queryOne<{ readonly id: string }>(
    `UPDATE evm_nonce_reservations
        SET status = 'staged', tx_hash = $2, updated_at = NOW()
      WHERE id = $1 AND status = 'reserved' AND tx_hash IS NULL
        AND lower(from_address) = lower($3) AND nonce = $4
      RETURNING id::text`,
    [reservationId, input.txHash, input.fromAddress, input.nonce],
  );
  if (row === null) throw new Error("evm nonce reservation: staging CAS missed");
}

export async function markLegacyEvmNonceAccepted(reservationId: number): Promise<void> {
  const row = await queryOne<{ readonly id: string }>(
    `UPDATE evm_nonce_reservations
        SET status = 'accepted', updated_at = NOW()
      WHERE id = $1 AND status = 'staged' AND tx_hash IS NOT NULL
      RETURNING id::text`,
    [reservationId],
  );
  if (row === null) throw new Error("evm nonce reservation: acceptance CAS missed");
}

export async function terminalizeLegacyEvmNonce(reservationId: number): Promise<void> {
  const row = await queryOne<{ readonly id: string }>(
    `UPDATE evm_nonce_reservations
        SET status = 'terminal', terminal_at = NOW(), updated_at = NOW(),
            repair_claim_until = NULL, repair_claim_token = NULL
      WHERE id = $1 AND status IN ('staged', 'accepted') AND tx_hash IS NOT NULL
      RETURNING id::text`,
    [reservationId],
  );
  if (row === null) throw new Error("evm nonce reservation: terminal CAS missed");
}

function assertClaimBounds(limit: number, leaseMs: number, intervalMs: number): void {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("evm nonce repair: limit must be an integer between 1 and 100");
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("evm nonce repair: leaseMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new Error("evm nonce repair: intervalMs must be a non-negative safe integer");
  }
}

/**
 * Claim a bounded, fair page of staged legacy reservations for read-only chain
 * observation. The finite lease and token fence make concurrent sweep drivers
 * disjoint and make a killed observer self-recovering.
 */
export async function claimDueEvmNonceReservations(
  limit: number = EVM_NONCE_REPAIR_LIMIT,
  leaseMs: number = EVM_NONCE_REPAIR_LEASE_MS,
  intervalMs: number = EVM_NONCE_REPAIR_INTERVAL_MS,
): Promise<ClaimDueEvmNonceReservationsResult> {
  assertClaimBounds(limit, leaseMs, intervalMs);
  const rows = await query<ClaimedReservationRow>(
    `WITH candidates AS (
       SELECT id
         FROM evm_nonce_reservations
        WHERE status IN ('staged', 'accepted') AND tx_hash IS NOT NULL
          AND (repair_claim_until IS NULL OR repair_claim_until < NOW())
          AND COALESCE(last_checked_at, updated_at)
              <= NOW() - make_interval(secs => $2::float8)
        ORDER BY COALESCE(last_checked_at, updated_at) ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE evm_nonce_reservations r
        SET repair_claim_until = NOW() + make_interval(secs => $3::float8),
            repair_claim_token = gen_random_uuid(), updated_at = NOW()
       FROM candidates c
      WHERE r.id = c.id
      RETURNING r.id::text, r.chain_id::text, r.from_address,
                r.nonce::text, r.tx_hash, r.status, r.repair_claim_token::text`,
    [limit, intervalMs / 1000, leaseMs / 1000],
  );
  const claimed = rows.map(mapClaimedReservation);
  if (claimed.length < limit) return { claimed, overflowDue: 0 };

  const overflow = await queryOne<{ readonly due: string }>(
    `SELECT COUNT(*)::text AS due
       FROM evm_nonce_reservations
      WHERE status IN ('staged', 'accepted') AND tx_hash IS NOT NULL
        AND (repair_claim_until IS NULL OR repair_claim_until < NOW())
        AND COALESCE(last_checked_at, updated_at)
            <= NOW() - make_interval(secs => $1::float8)`,
    [intervalMs / 1000],
  );
  return { claimed, overflowDue: overflow === null ? 0 : Number(overflow.due) };
}

function mapClaimedReservation(row: ClaimedReservationRow): ClaimedEvmNonceReservation {
  const id = Number(row.id);
  const chainId = Number(row.chain_id);
  const nonce = Number(row.nonce);
  if (
    !Number.isSafeInteger(id)
    || id <= 0
    || !Number.isSafeInteger(chainId)
    || chainId <= 0
    || !Number.isSafeInteger(nonce)
    || nonce < 0
  ) {
    throw new Error("evm nonce repair: claimed row contains an unsafe integer");
  }
  return {
    id,
    chainId,
    fromAddress: row.from_address,
    nonce,
    txHash: row.tx_hash,
    status: row.status,
    claimToken: row.repair_claim_token,
  };
}

/** Apply only a conclusive read-only observation. Never signs or broadcasts. */
export async function terminalizeClaimedEvmNonceReservation(
  id: number,
  claimToken: string,
  reason: EvmNonceRepairTerminalReason,
): Promise<boolean> {
  const row = await queryOne<{ readonly id: string }>(
    `UPDATE evm_nonce_reservations
        SET status = 'terminal', terminal_reason = $3, terminal_at = NOW(),
            last_checked_at = NOW(), last_verification_reason = NULL,
            repair_claim_until = NULL, repair_claim_token = NULL, updated_at = NOW()
      WHERE id = $1 AND status IN ('staged', 'accepted')
        AND tx_hash IS NOT NULL AND repair_claim_token = $2::uuid
      RETURNING id::text`,
    [id, claimToken, reason],
  );
  return row !== null;
}

/**
 * Rotate an inconclusive observation to the back of the due queue. The token
 * fence prevents a late observer from releasing a newer worker's claim.
 */
export async function rotateInconclusiveEvmNonceReservation(
  id: number,
  claimToken: string,
  reason: EvmNonceRepairInconclusiveReason,
): Promise<boolean> {
  const row = await queryOne<{ readonly id: string }>(
    `UPDATE evm_nonce_reservations
        SET last_checked_at = NOW(), verification_attempts = verification_attempts + 1,
            last_verification_reason = $3,
            repair_claim_until = NULL, repair_claim_token = NULL, updated_at = NOW()
      WHERE id = $1 AND status IN ('staged', 'accepted')
        AND tx_hash IS NOT NULL AND repair_claim_token = $2::uuid
      RETURNING id::text`,
    [id, claimToken, reason],
  );
  return row !== null;
}
