/**
 * `wallet_wrap_intents` repo - the durable half of the native <-> wrapped-native
 * wrap/unwrap capability (migration 096).
 *
 * ## Session ownership
 *
 * EVERY mutation and lookup carries `session_id` in the predicate. A confirm,
 * read or cancel from a different session must MISS even when the intent id is
 * known. This is the same invariant `wallet-transaction-intents.ts` carries and
 * for the same reason: an intent id is not a capability.
 *
 * ## `rowCount` discipline
 *
 * Every CAS returns the mapped row or `null`. `null` is a hard "race lost"
 * signal - the from-status, the session, the expiry and (for the claim) the
 * proposal digest are all in the WHERE clause, so `null` says "the state you
 * assumed is not the state that exists". Nothing here retries on its own; a
 * signing path never retries at all.
 *
 * ## Client-bound writers (contract C7)
 *
 * Every function that moves a row into or out of a gate-visible status takes an
 * explicit `PoolClient` and has NO pool-level variant. These rows are money
 * state that the compaction safe-moment gate reads
 * (`./approval-intents/money-state.ts`), and that gate is only sound if the
 * writers serialize with it on the session control lock. Requiring the client
 * makes "this write happened inside a session-control-locked transaction" a
 * compile-time obligation instead of a convention. That transaction stays
 * DB-only and COMMITs before any signing or provider call.
 *
 * Reads stay pool-level: a read does not change the gate's answer.
 *
 * ## What is NOT here
 *
 * The claim TRANSACTION (claim + activity insert + protocol_executions insert +
 * activity stamp, one transaction under the session lock) belongs to the wrap
 * confirm handler. This module ships the CAS PRIMITIVES that transaction
 * composes, so the primitives can be tested for their predicates independently
 * of the orchestration that uses them.
 *
 * There is no fee anything on this path, by construction: the table has no fee
 * column, so this repo has nothing to read or write one from.
 */

import type { PoolClient } from "pg";

import { query, queryOne } from "../client.js";
import { jsonb } from "../params.js";
import { casRow } from "./wallet-intent-lifecycle.js";


// ── DTO, columns and strict row parsing ────────────────────────────────

// The DTO, `SELECT_COLUMNS` and `parseWrapIntentRow` live in the sibling
// `./wallet-wrap-intents/row.js`. RE-EXPORTED here so this module stays the
// single public gate of the repo.
export type {
  WrapDirection,
  WalletWrapIntent,
  CreateWalletWrapIntentInput,
} from "./wallet-wrap-intents/row.js";
export { parseWrapIntentRow } from "./wallet-wrap-intents/row.js";

import type {
  WalletWrapIntent,
  CreateWalletWrapIntentInput,
} from "./wallet-wrap-intents/row.js";
import { SELECT_COLUMNS, parseWrapIntentRow } from "./wallet-wrap-intents/row.js";


function cas(
  client: PoolClient,
  sql: string,
  params: readonly unknown[],
): Promise<WalletWrapIntent | null> {
  return casRow(client, sql, params, parseWrapIntentRow);
}

// ── Prepare inserts `pending` ──────────────────────────────────────────

const INSERT_SQL = `INSERT INTO wallet_wrap_intents (
  intent_id, session_id, wallet_address, chain_alias, chain_id, direction,
  wrapped_native_address, wrapped_native_symbol, wrapped_native_decimals,
  amount_raw, payload_json, preview_json, fee_bounds_json,
  proposal_digest, proposal_digest_version, expires_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, $16)`;

/**
 * Client-bound because creation is the transition a row lock cannot exclude:
 * the row has no identity to lock until it exists, so it must happen under the
 * session control lock or the compaction gate can read `clear` a microsecond
 * before an intent appears.
 */
export async function createWith(
  client: PoolClient,
  input: CreateWalletWrapIntentInput,
): Promise<void> {
  await client.query(INSERT_SQL, [
    input.intentId,
    input.sessionId,
    input.walletAddress,
    input.chainAlias,
    input.chainId,
    input.direction,
    input.contract.address,
    input.contract.symbol,
    input.contract.decimals,
    input.amountRaw,
    jsonb(input.payload),
    jsonb(input.preview),
    jsonb(input.feeBounds),
    input.proposalDigest,
    input.proposalDigestVersion,
    input.expiresAt,
  ]);
}

// ── Reads (pool-level; a read cannot move the gate) ────────────────────

/**
 * The intent row inside the CALLER's transaction. Client-bound so a terminal
 * settlement can read the row it is about to write through the SAME connection
 * that holds its uncommitted changes and its session control lock; a
 * pool-level read would answer from a different snapshot and would block on
 * this transaction's own row lock.
 */
export async function getByIdWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<WalletWrapIntent | null> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_wrap_intents
      WHERE intent_id = $1 AND session_id = $2`,
    [intentId, sessionId],
  );
  const row = res.rows[0];
  return row === undefined ? null : parseWrapIntentRow(row);
}

export async function getById(
  intentId: string,
  sessionId: string,
): Promise<WalletWrapIntent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_wrap_intents
      WHERE intent_id = $1 AND session_id = $2`,
    [intentId, sessionId],
  );
  return row ? parseWrapIntentRow(row) : null;
}

export async function getPendingForSession(
  sessionId: string,
): Promise<readonly WalletWrapIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_wrap_intents
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY created_at ASC`,
    [sessionId],
  );
  return rows.map(parseWrapIntentRow);
}

/**
 * The intent an ACTIVITY row belongs to, if any. The repair lanes' entry point:
 * they own the activity row and reach the intent through the link the claim
 * transaction stamped.
 *
 * NOT session-scoped, and deliberately so: a repair lane runs outside any
 * session and holds an activity id, not a session id. The session travels back
 * ON the row, and every WRITE the lane then performs carries it in its own
 * predicate - so the ownership invariant is preserved at the write, which is
 * where it protects something.
 */
export async function getByActivityId(
  activityId: number,
): Promise<WalletWrapIntent | null> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_wrap_intents WHERE activity_id = $1`,
    [activityId],
  );
  return row ? parseWrapIntentRow(row) : null;
}

/**
 * The intent linked to an activity row, read on the CALLER's transaction.
 * Atomic repair settlement must use this twin: a pool-level read cannot see
 * sibling writes made by the transaction that holds the session control lock.
 */
export async function getByActivityIdWith(
  client: PoolClient,
  activityId: number,
): Promise<WalletWrapIntent | null> {
  const res = await client.query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS} FROM wallet_wrap_intents WHERE activity_id = $1`,
    [activityId],
  );
  const row = res.rows[0];
  return row === undefined ? null : parseWrapIntentRow(row);
}

/** A `consuming` wrap intent whose handler is gone, joined to what its activity row proves. */
export interface StrandedWrapIntent {
  readonly intent: WalletWrapIntent;
  readonly activityId: number;
  readonly protocolExecutionId: number;
  /** The STAGED hash, or `null`. Staging strictly precedes broadcast, so `null` proves no broadcast. */
  readonly stagedTxHash: string | null;
  readonly activityStatus: string;
  /**
   * The activity row's failure code, when it has one. Read so the stranded scan
   * can tell an already-terminal row's CHAIN verdict apart - a `mined_revert` is
   * evidence the transaction ran and reverted, an expiry is absence of proof -
   * without asking the chain a question a lane already answered.
   */
  readonly activityFailureCode: string | null;
  readonly executionStatus: string;
}

/**
 * Linked `consuming` rows whose claim is older than the handler window.
 *
 * The age gate is what makes this recovery and not interference: while a
 * confirm handler is running its row is legitimately `consuming`, and a sweep
 * that terminalized it would be racing a live signing path. `consumed_at` is
 * stamped by the claim, so it measures exactly the right thing.
 *
 * UNLINKED rows are excluded by the join, which is correct: the claim and the
 * link happen in ONE transaction, so an unlinked `consuming` row cannot exist.
 */
export async function listStrandedConsuming(
  olderThanMs: number,
  limit: number,
): Promise<readonly StrandedWrapIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT ${SELECT_COLUMNS.split(", ").map((c) => `t.${c}`).join(", ")},
            a.id AS aa_id, a.tx_hash AS aa_tx_hash, a.status AS aa_status,
            a.failure_code AS aa_failure_code,
            a.protocol_execution_id AS aa_execution_id,
            e.execution_status AS pe_status
       FROM wallet_wrap_intents t
       JOIN agent_activity a ON a.id = t.activity_id
       LEFT JOIN protocol_executions e ON e.id = a.protocol_execution_id
      WHERE t.status = 'consuming'
        AND t.consumed_at IS NOT NULL
        AND t.consumed_at <= NOW() - ($1::bigint * INTERVAL '1 millisecond')
      ORDER BY t.consumed_at ASC
      LIMIT $2`,
    [String(olderThanMs), limit],
  );
  return rows.map((r) => ({
    intent: parseWrapIntentRow(r),
    activityId: Number(r.aa_id),
    protocolExecutionId: Number(r.aa_execution_id),
    stagedTxHash: (r.aa_tx_hash as string | null) ?? null,
    activityStatus: String(r.aa_status),
    activityFailureCode: (r.aa_failure_code as string | null) ?? null,
    executionStatus: r.pe_status === null || r.pe_status === undefined ? "" : String(r.pe_status),
  }));
}

// ── Claim ──────────────────────────────────────────────────────────────

/**
 * The CAS half of the claim. `pending` + owning session + NOT expired + the
 * proposal digest the caller believes it approved.
 *
 * The digest is IN THE PREDICATE rather than compared afterwards: a compare
 * after a successful claim would have already consumed a row whose proposal
 * drifted, leaving a `consuming` intent nobody may execute. Refusing at the
 * predicate leaves the row `pending` and the operator free to cancel it.
 *
 * The caller runs this inside ONE transaction that also creates the activity
 * and protocol_execution rows and calls {@link stampActivityWith}, so a crash
 * can never strand a claimed intent with no activity row to recover from.
 */
export async function claimIfPendingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  expectedProposalDigest: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'consuming', consumed_at = NOW()
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'pending'
        AND expires_at > NOW()
        AND proposal_digest = $3
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, expectedProposalDigest],
  );
}

/**
 * The LINK half, stamped in the SAME transaction as the claim. The
 * `activity_id IS NULL` predicate makes it idempotent-by-refusal: a second
 * stamp for the same intent misses instead of silently repointing an intent at
 * a different activity row.
 */
export async function stampActivityWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  activityId: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET activity_id = $3
      WHERE intent_id = $1
        AND session_id = $2
        AND status = 'consuming'
        AND activity_id IS NULL
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, activityId],
  );
}

// ── Terminal and ambiguous writes from `consuming` ─────────────────────

/** Definitive success. `tx_hash` is REQUIRED by the migration's evidence CHECK. */
export async function markExecutedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'executed', tx_hash = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash],
  );
}

/**
 * THE ANOMALY TERMINAL. The transaction CONFIRMED and its receipt proved a
 * quantity that CONTRADICTS the approved amount.
 *
 * Deliberately not `executed`, which asserts the operation happened as
 * approved, and deliberately not `failed`, which would claim nothing moved when
 * the transaction is on-chain. The hash is REQUIRED by the migration's evidence
 * CHECK - a real transaction exists and an operator reads the receipt from it -
 * and the row BLOCKS the compaction money-state gate until a human resolves it.
 *
 * Written from `consuming`, the immediate confirm path. NOTHING in this build
 * moves a row out of `review_required`: that is a human's decision, and an
 * automatic exit would recreate the silent-resolution defect this status exists
 * to prevent.
 */
export async function markReviewRequiredWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'review_required', tx_hash = $3, failure_reason = $4
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash, reason],
  );
}

/**
 * The chain executed the transaction and it reverted. A real transaction
 * exists, so the hash is REQUIRED: the operator reads the receipt from it.
 */
export async function markChainFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'failed', failure_stage = 'chain_reverted',
            tx_hash = $3, failure_reason = $4
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash, reason],
  );
}

/**
 * The attempt failed BEFORE anything was broadcast. `tx_hash` stays NULL by
 * CHECK: a hash here would assert a broadcast that never happened, and it is
 * the one row shape from which preparing again is safe.
 */
export async function markPreBroadcastFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'failed', failure_stage = 'pre_broadcast', failure_reason = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason],
  );
}

/**
 * ONE primitive for two arrivals at the same durable fact: a broadcast happened
 * and its outcome is not provable yet. The handler returning
 * `confirmation_unknown` on a NORMAL return, and crash recovery finding a
 * linked `consuming` row WITH a staged hash.
 *
 * This is never `failed`-with-a-hash. That shape cannot be told apart from a
 * revert, and a caller who reads "failed" retries.
 */
export async function markBroadcastUnconfirmedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  txHash: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'broadcast_unconfirmed', tx_hash = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, txHash],
  );
}

/**
 * Crash recovery found a linked `consuming` row with NO staged hash. Staging
 * strictly precedes broadcast, so no hash PROVES no broadcast, and the row is
 * honestly terminal with `tx_hash` NULL.
 */
export async function markCrashedBeforeBroadcastWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'failed', failure_stage = 'crashed_before_broadcast', failure_reason = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason],
  );
}

/**
 * The staged-evidence write itself failed BEFORE broadcast, so nothing was
 * signed. `tx_hash` is NULL by CHECK, the row RELEASES the money-state gate,
 * and it is distinct from `failed` so investigation tooling can find "our audit
 * write broke" without trawling every failure.
 */
export async function markAuditFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'audit_failed', failure_reason = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'consuming'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason],
  );
}

// ── The repair lanes settle a broadcast_unconfirmed row ────────────────

/** Confirmed branch. Only a repair lane holding definitive chain evidence calls this. */
export async function settleUnconfirmedAsExecutedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'executed'
      WHERE intent_id = $1 AND session_id = $2 AND status = 'broadcast_unconfirmed'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}

/** Reverted branch. The hash is already on the row and is retained. */
export async function settleUnconfirmedAsChainFailedWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'failed', failure_stage = 'chain_reverted', failure_reason = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'broadcast_unconfirmed'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason],
  );
}

/**
 * The chain moved past the transaction without ever proving it: the nonce was
 * consumed by something else, or the replacement won. `failed` would lie about
 * evidence we do not have, and staying `broadcast_unconfirmed` would block the
 * money-state gate forever, so this is its own honest terminal. The hash is
 * retained for investigation.
 */
export async function markSupersededUnprovenWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
  reason: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'superseded_unproven', failure_reason = $3
      WHERE intent_id = $1 AND session_id = $2 AND status = 'broadcast_unconfirmed'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId, reason],
  );
}

// ── TTL sweep ──────────────────────────────────────────────────────────

/**
 * Expire this session's stale `pending` rows.
 *
 * Session-scoped and client-bound on purpose: expiry moves a row OUT of the
 * money-state gate's live set, so it is a gate-visible write like any other and
 * must serialize on the same session control lock. A global sweep would take
 * one lock it does not own and release another session's gate behind its back.
 *
 * Returns the expired rows so the caller can log exactly what it retired.
 */
export async function expireStalePendingWith(
  client: PoolClient,
  sessionId: string,
): Promise<readonly WalletWrapIntent[]> {
  const res = await client.query<Record<string, unknown>>(
    `UPDATE wallet_wrap_intents
        SET status = 'expired'
      WHERE session_id = $1 AND status = 'pending' AND expires_at <= NOW()
      RETURNING ${SELECT_COLUMNS}`,
    [sessionId],
  );
  return res.rows.map(parseWrapIntentRow);
}

// ── Cancel ─────────────────────────────────────────────────────────────

/** CAS-guarded against the race with a concurrent claim. */
export async function cancelIfPendingWith(
  client: PoolClient,
  intentId: string,
  sessionId: string,
): Promise<WalletWrapIntent | null> {
  return cas(
    client,
    `UPDATE wallet_wrap_intents
        SET status = 'cancelled', cancelled_at = NOW()
      WHERE intent_id = $1 AND session_id = $2 AND status = 'pending'
      RETURNING ${SELECT_COLUMNS}`,
    [intentId, sessionId],
  );
}
