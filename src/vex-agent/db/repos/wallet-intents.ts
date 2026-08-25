/**
 * Wallet intents repo — durable transfer prepare/confirm.
 *
 * Replaces the process-local `pendingIntents = new Map<...>` in
 * `src/vex-agent/tools/internal/wallet/send.ts`. Plan §05 §"Wallet intents":
 * confirm must survive process restart, gate on expiry/consumed/cancelled,
 * and persist tx hash; private keys NEVER reach this repo.
 *
 * Migration: `src/vex-agent/db/migrations/025_wallet_intents.sql`.
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

import { query, queryOne } from "../client.js";
import { jsonb } from "../params.js";
// The mechanics `wallet_transaction_intents` genuinely shares with this table:
// TIMESTAMPTZ normalisation and the CAS `rowCount` discipline. The STATE
// MACHINES are deliberately NOT shared; see that module's header.
import { casRow as casRowShared, toIso, toIsoOrNull } from "./wallet-intent-lifecycle.js";

export type WalletIntentNetwork = "eip155" | "solana";
export type WalletIntentStatus =
  | "pending"
  | "consuming"
  | "executed"
  | "failed"
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
  expiresAt: string;
  consumedAt: string | null;
  cancelledAt: string | null;
  txHash: string | null;
  failureReason: string | null;
  idempotencyKey: string | null;
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
  "expires_at, consumed_at, cancelled_at, tx_hash, failure_reason, " +
  "idempotency_key, created_at";

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
    expiresAt: toIso(r.expires_at as string | Date),
    consumedAt: toIsoOrNull(r.consumed_at as string | Date | null),
    cancelledAt: toIsoOrNull(r.cancelled_at as string | Date | null),
    txHash: r.tx_hash as string | null,
    failureReason: r.failure_reason as string | null,
    idempotencyKey: r.idempotency_key as string | null,
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
 * Mark a consuming intent as failed. `txHash` is non-null when broadcast
 * went through but chain reverted / confirmation timed out — the operator
 * needs the hash to investigate on-chain (Codex puzzle-5 phase-4 review
 * point 2 — `failed` MAY carry tx_hash).
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
