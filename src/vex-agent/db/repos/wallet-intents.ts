/**
 * Wallet intents repo — durable transfer prepare/confirm.
 *
 * Replaces the process-local `pendingIntents = new Map<...>` in
 * `src/vex-agent/tools/internal/wallet/send.ts`. Plan §05 §"Wallet intents":
 * confirm must survive process restart, gate on expiry/consumed/cancelled,
 * and persist tx hash; private keys NEVER reach this repo.
 *
 * Migrations: `025_wallet_intents.sql` through
 * `093_wallet_transfer_unconfirmed_repair.sql`.
 *
 * **Session ownership invariant** (Codex puzzle-5 phase-4 review point 3):
 * EVERY mutation + lookup includes `session_id` in the predicate. A confirm
 * / get / cancel from a different session must miss even when the
 * `intent_id` is known. Tests pin the cross-session race.
 *
 * **`rowCount` discipline** (Codex final review constraint): every CAS
 * helper returns the mapped row (or `null`) — `rowCount=0` is NEVER a
 * silent success. Callers gate on the null return to detect races.
 *
 * **Client-bound writers** (compaction v2, contract C7): every function that
 * moves an intent into or out of a live status takes an explicit `PoolClient`
 * and has NO pool-level variant. A wallet intent is money state that the
 * compaction safe-moment gate reads
 * (`./approval-intents/money-state.ts`), and that gate is only sound if the
 * writers serialize with it on the session control lock. Requiring the client
 * is what makes "this write happened inside a session-control-locked
 * transaction" a compile-time obligation rather than a convention. Callers use
 * `withSessionControlLock(sessionId, …)`; that transaction must stay DB-only
 * and COMMIT before any signing or provider call.
 *
 * Read paths (`getById`, `getPendingForSession`) stay pool-level: reads do not
 * change the gate's answer.
 */

import type { PoolClient } from "pg";

import { query, queryOne, queryOneWith } from "../client.js";
import { jsonb } from "../params.js";
// The mechanics `wallet_transaction_intents` genuinely shares with this table:
// TIMESTAMPTZ normalisation and the CAS `rowCount` discipline. The STATE
// MACHINES are deliberately NOT shared; see that module's header.
import { casRow as casRowShared, toIso, toIsoOrNull } from "./wallet-intent-lifecycle.js";

export type WalletIntentNetwork = "eip155" | "solana";
export type WalletIntentStatus =
  | "pending"
  | "consuming"
  | "broadcast_unconfirmed"
  | "executed"
  | "failed"
  | "superseded_unproven"
  | "review_required"
  | "audit_failed"
  | "cancelled"
  | "expired";

export interface WalletIntentPreview {
  /**
   * One-line human-readable summary, e.g.
   * "Send 1.5 ETH to 0x1111111111111111111111111111111111111111 on base".
   * Addresses are carried WHOLE: an elided address is the shape an
   * address-poisoning attack targets, and this is the sentence a human
   * authorizes an irreversible transfer from.
   */
  label: string;
  /** Allow-listed scalar arg map for the UI critical-args panel. */
  criticalArgs: Record<string, string | number | boolean | null>;
}

export interface WalletIntent {
  intentId: string;
  sessionId: string;
  walletAddress: string;
  network: WalletIntentNetwork;
  chainAlias: string | null;
  toAddress: string;
  amount: string;
  token: string | null;
  previewJson: WalletIntentPreview | Record<string, unknown>;
  status: WalletIntentStatus;
  /** The one durable wallet_transfer row whose staged hash this intent owns. */
  activityId: string | null;
  expiresAt: string;
  consumedAt: string | null;
  cancelledAt: string | null;
  txHash: string | null;
  failureReason: string | null;
  idempotencyKey: string | null;
  repairCheckedAt: string | null;
  createdAt: string;
}

export interface CreateInput {
  intentId: string;
  sessionId: string;
  walletAddress: string;
  network: WalletIntentNetwork;
  chainAlias: string | null;
  toAddress: string;
  amount: string;
  token: string | null;
  previewJson: WalletIntentPreview | Record<string, unknown>;
  expiresAt: string;
  idempotencyKey?: string | null;
}

const SELECT_COLUMNS =
  "intent_id, session_id, wallet_address, network, chain_alias, " +
  "to_address, amount, token, preview_json, status, " +
  "activity_id, expires_at, consumed_at, cancelled_at, tx_hash, failure_reason, " +
  "idempotency_key, repair_checked_at, created_at";

function mapRow(r: Record<string, unknown>): WalletIntent {
  return {
    intentId: r.intent_id as string,
    sessionId: r.session_id as string,
    walletAddress: r.wallet_address as string,
    network: r.network as WalletIntentNetwork,
    chainAlias: r.chain_alias as string | null,
    toAddress: r.to_address as string,
    amount: r.amount as string,
    token: r.token as string | null,
    previewJson:
      (r.preview_json as Record<string, unknown>) ?? { label: "", criticalArgs: {} },
    status: r.status as WalletIntentStatus,
    activityId: r.activity_id === null || r.activity_id === undefined
      ? null
      : String(r.activity_id),
    expiresAt: toIso(r.expires_at as string | Date),
    consumedAt: toIsoOrNull(r.consumed_at as string | Date | null),
    cancelledAt: toIsoOrNull(r.cancelled_at as string | Date | null),
    txHash: r.tx_hash as string | null,
    failureReason: r.failure_reason as string | null,
    idempotencyKey: r.idempotency_key as string | null,
    repairCheckedAt: toIsoOrNull(r.repair_checked_at as string | Date | null),
    createdAt: toIso(r.created_at as string | Date),
  };
}

/**
 * Run one CAS `UPDATE … RETURNING` on the caller's transaction and map the row.
 * `null` means the predicate missed — a hard "race lost" signal, never a silent
 * success (see the `rowCount` discipline in the header).
 */
function casRow(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<WalletIntent | null> {
  return casRowShared(client, sql, params, mapRow);
}

// ── create ──────────────────────────────────────────────────────────────

const INSERT_SQL = `INSERT INTO wallet_intents (
  intent_id, session_id, wallet_address, network, chain_alias,
  to_address, amount, token, preview_json, expires_at, idempotency_key
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`;

/**
 * Insert a fresh `pending` intent — the moment a session gains live money
 * state. Client-bound: creation is precisely the transition a row lock cannot
 * exclude (the row has no identity to lock until it exists), so it MUST happen
 * under the session control lock or the compaction gate can read `clear` a
 * microsecond before an intent appears.
 */
export async function createWith(client: PoolClient, input: CreateInput): Promise<void> {
  await client.query(INSERT_SQL, [
    input.intentId,
    input.sessionId,
    input.walletAddress,
    input.network,
    input.chainAlias,
    input.toAddress,
    input.amount,
    input.token,
    jsonb(input.previewJson),
    input.expiresAt,
    input.idempotencyKey ?? null,
  ]);
}

// ── getById (session-scoped) ────────────────────────────────────────────

export async function getById(
  intentId: string,
  sessionId: string,
): Promise<WalletIntent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_intents WHERE intent_id = $1 AND session_id = $2`,
    [intentId, sessionId],
  );
  return row ? mapRow(row) : null;
}

/** Read a linked transfer intent on the caller's settlement transaction. */
export async function getByActivityIdWith(
  client: PoolClient,
  activityId: number,
): Promise<WalletIntent | null> {
  const row = await queryOneWith<Record<string, unknown>>(
    client,
    `SELECT ${SELECT_COLUMNS} FROM wallet_intents WHERE activity_id = $1`,
    [activityId],
  );
  return row ? mapRow(row) : null;
}

// ── consumeIfPending (CAS, session-scoped) ──────────────────────────────

/**
 * CAS-claim a pending intent for execution. Returns the row (with new
 * status='consuming') on success, `null` when the predicate misses
 * (already consumed/executed/cancelled, OR expires_at past, OR a different
 * session). `null` is a hard "race lost" signal — callers MUST gate on it.
 */
export async function consumeIfPendingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = 'consuming', consumed_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'pending'
        AND expires_at > NOW()
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}

/**
 * Bind the claimed transfer intent to the wallet_transfer activity created for
 * it. The caller creates AA and PE in this same transaction before signing.
 */
export async function linkActivityWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET activity_id = $3
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'consuming'
        AND activity_id IS NULL
        AND EXISTS (
          SELECT 1
            FROM agent_activity a
           WHERE a.id = $3
             AND a.session_id = $2
             AND a.event_role = 'wallet_transfer'
             AND a.status = 'pending'
        )
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, activityId],
  );
}

/**
 * The submit outcome is ambiguous but the signed hash is durably staged on the
 * linked activity. This is unresolved money state, never `failed`.
 */
export async function markBroadcastUnconfirmedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
  reason: string,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents w
        SET status = 'broadcast_unconfirmed', tx_hash = $3, failure_reason = $4
      WHERE w.intent_id = $1
        AND w.session_id = $2
        AND w.status = 'consuming'
        AND w.activity_id IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM agent_activity a
           WHERE a.id = w.activity_id
             AND a.session_id = w.session_id
             AND a.event_role = 'wallet_transfer'
             AND a.status = 'pending'
             AND a.tx_hash = $3
        )
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash, reason],
  );
}

// ── markExecuted (session-scoped) ───────────────────────────────────────

export async function markExecutedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = 'executed', tx_hash = $3
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash],
  );
}

// ── markFailed (session-scoped; txHash optional) ────────────────────────

/**
 * Mark a consuming intent as definitively failed. `txHash` is non-null only
 * when chain evidence proved a revert. An ambiguous broadcast uses
 * `markBroadcastUnconfirmedWith` instead.
 *
 * `reason` MUST be a structural-only label (`ErrorKind:errorHash`) — raw
 * cause messages MUST NEVER reach this column. Callers (send.ts) build
 * the label via `summarizeWalletError`; the DB CHECK does not enforce the
 * format but the test suite pins it.
 */
export async function markFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
  txHash: string | null = null,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = 'failed', failure_reason = $3, tx_hash = $4
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason, txHash],
  );
}

/** Settle a linked ambiguous transfer from the observer's confirmed evidence. */
export async function settleLinkedAsExecutedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
  txHash: string,
): Promise<WalletIntent | null> {
  return settleLinkedWith(client, intentId, sessionId, activityId, "executed", txHash, null);
}

/** Settle a linked ambiguous transfer from a mined-revert verdict. */
export async function settleLinkedAsFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
  txHash: string,
): Promise<WalletIntent | null> {
  return settleLinkedWith(
    client,
    intentId,
    sessionId,
    activityId,
    "failed",
    txHash,
    "RepairLane:chain_reverted",
  );
}

/** Settle a linked transfer when non-inclusion is proven but execution is not. */
export async function settleLinkedAsSupersededWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
  txHash: string,
): Promise<WalletIntent | null> {
  return settleLinkedWith(
    client,
    intentId,
    sessionId,
    activityId,
    "superseded_unproven",
    txHash,
    "RepairLane:superseded_unproven",
  );
}

/** Settle a linked row that provably never reached staging or broadcast. */
export async function settleLinkedAsCrashedBeforeBroadcastWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
): Promise<WalletIntent | null> {
  return settleLinkedWith(
    client,
    intentId,
    sessionId,
    activityId,
    "failed",
    null,
    "CrashRecovery:no_staged_hash",
  );
}

/**
 * Settle a linked transfer whose signature was staged locally but whose node
 * definitively rejected the bytes before accepting a broadcast. The staged
 * signature stays on AA as local audit evidence; WI keeps tx_hash NULL because
 * nothing reached the network.
 */
export async function settleLinkedAsSignedNotSubmittedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
): Promise<WalletIntent | null> {
  return settleLinkedWith(
    client,
    intentId,
    sessionId,
    activityId,
    "failed",
    null,
    "PreBroadcast:signed_not_submitted",
  );
}

function settleLinkedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: number,
  status: Extract<WalletIntentStatus, "executed" | "failed" | "superseded_unproven">,
  txHash: string | null,
  failureReason: string | null,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = $4, tx_hash = $5, failure_reason = $6
      WHERE intent_id = $1
        AND session_id = $2
        AND activity_id = $3
        AND status IN ('consuming', 'broadcast_unconfirmed')
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, activityId, status, txHash, failureReason],
  );
}

// ── markAuditFailed (session-scoped; tx is real on-chain) ───────────────

/**
 * `markExecuted` itself failed AFTER a real on-chain tx hash arrived.
 * The tx is real; the audit row is now inconsistent. Distinct from
 * `markFailed` so phase 7 reconcile tooling can find these rows
 * specifically (Codex puzzle-5 phase-4 review point 2).
 */
export async function markAuditFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
  reason: string,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = 'audit_failed', tx_hash = $3, failure_reason = $4
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash, reason],
  );
}

// ── cancelIfPending (CAS, session-scoped) ───────────────────────────────

export async function cancelIfPendingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = 'cancelled', cancelled_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'pending'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}

// ── getPendingForSession ────────────────────────────────────────────────

export async function getPendingForSession(
  sessionId: string,
): Promise<WalletIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_intents
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [sessionId],
  );
  return rows.map(mapRow);
}

/**
 * Migration 093 names every hash that could not be classified from matching
 * activity evidence `review_required`. These bounded readers let the existing
 * read-only chain observers resolve it without signing or rebroadcasting.
 */
export async function listLegacyReviewCandidates(
  network: WalletIntentNetwork,
  limit: number,
): Promise<WalletIntent[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100) {
    throw new Error("wallet intent review: limit must be an integer between 1 and 100");
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS}
       FROM wallet_intents
      WHERE network = $1
        AND status = 'review_required'
        AND tx_hash IS NOT NULL
      ORDER BY repair_checked_at ASC NULLS FIRST, created_at ASC, intent_id ASC
      LIMIT $2`,
    [network, limit],
  );
  return rows.map(mapRow);
}

/** Rotate an inconclusive legacy observation to the back of the bounded queue. */
export async function touchLegacyReviewWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET repair_checked_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'review_required'
        AND tx_hash IS NOT NULL
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}

/**
 * Apply a conclusive read-only chain verdict to a migration review row. The hash
 * predicate makes a stale observer lose instead of settling replacement state.
 */
export async function settleLegacyReviewWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
  verdict: "confirmed" | "reverted",
): Promise<WalletIntent | null> {
  return casRow(
    client,
    `UPDATE wallet_intents
        SET status = CASE WHEN $4 = 'confirmed' THEN 'executed' ELSE 'failed' END,
            failure_reason = CASE WHEN $4 = 'confirmed' THEN NULL ELSE 'RepairLane:chain_reverted' END,
            repair_checked_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'review_required'
        AND tx_hash = $3
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash, verdict],
  );
}
