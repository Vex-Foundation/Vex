/**
 * AgentScan reporting repo — the state singleton + outbox behind the
 * `agentscan_report` sync lane (migration 073).
 *
 * ── The diff scan, not writer hooks ────────────────────────────────────────
 *
 * `enqueueEligibleActivity` is the ONLY producer of outbox rows. It diffs
 * `agent_activity` against the outbox's `UNIQUE (activity_id, status)` pair,
 * so it captures both brand-new rows and status transitions idempotently —
 * with ZERO code in the money-path writers. Completed outbox rows are kept
 * forever as the report-log; deleting them would let the scan re-enqueue the
 * same pair on every tick.
 *
 * ── Claim-and-stamp (crash-safe drain) ─────────────────────────────────────
 *
 * `claimDueOutbox` bumps `attempt_count` and pushes `next_attempt_at`
 * (exponential, capped 1 h) BEFORE the caller sends, exactly like the
 * launch-attribution lane: a crash mid-send retries after the backoff instead
 * of hot-looping, and the server deduplicates retried batches, so re-sending
 * is always safe. `rescheduleOutbox` overrides the stamp when the server
 * answered with its own `Retry-After`.
 *
 * ── What never goes in here ────────────────────────────────────────────────
 *
 * `last_error` carries status/code words only ("429 rate_limited"), never
 * response bodies and never the ingest token. The eligibility predicate keeps
 * rows outside the REPORTED vocabulary below out of the outbox entirely.
 */

import type { PoolClient } from "pg";
import { query, queryOne, execute, withTransaction } from "../client.js";
import type {
  AgentActivityEventRole,
  AgentActivityKind,
  AgentActivityStatus,
} from "./agent-activity/types.js";

export type AgentscanStopReason = "consent_revoked" | "quarantined" | "agent_conflict" | "wallet_conflict";

export interface AgentscanReportingState {
  readonly agentHash: string | null;
  readonly ingestToken: string | null;
  readonly consentVersion: number;
  readonly acceptedAt: string | null;
  readonly registeredAt: string | null;
  readonly registerAttemptCount: number;
  readonly nextRegisterAttemptAt: string;
  readonly backfillEnqueuedAt: string | null;
  readonly stoppedReason: AgentscanStopReason | null;
  /** Display name AgentScan bound to this install (session/complete response). */
  readonly agentName: string | null;
  /** When the last successful wallet-binding handshake completed. */
  readonly lastHandshakeAt: string | null;
  /** session/complete's syncState.lastAcceptedRowId — null for a brand-new agent. */
  readonly serverCursorRowId: number | null;
  /** sha256 of the sorted chainFamily:address inventory list the last handshake covered. */
  readonly boundWalletsFingerprint: string | null;
}

export interface ClaimedOutboxEvent {
  readonly outboxId: number;
  readonly activityId: number;
  readonly status: AgentActivityStatus;
  readonly backfill: boolean;
  /** Raw `agent_activity` row for payload building; null if the row vanished between claim and read. */
  readonly activity: Record<string, unknown> | null;
}

/**
 * WHAT IS REPORTABLE — as data, not as a hand-written SQL list.
 *
 * Every kind and status Vex records is reported, and every role except the two
 * approval roles named below: AgentScan's contract accepts that vocabulary, so
 * no contract-inexpressible arm is left to filter. Any FURTHER exclusion has to
 * be named here WITH its reason and added to `DELIBERATELY_UNREPORTED_KINDS` /
 * `DELIBERATELY_UNREPORTED_ROLES` in
 * `src/__tests__/vex-agent/agentscan/reporting-vocabulary-lockstep.test.ts` —
 * an omission is a bug, never a decision.
 *
 * DELIBERATELY UNREPORTED: `allowance` and `allowance_reset`. AgentScan's
 * `daily_aggregates` carries a `tx_count` that is written incrementally and
 * NEVER recomputed from raw events (it has to survive the raw-event purge).
 * Reporting approval rows would make that published count mean "operations plus
 * an unpredictable number of ERC-20 approvals" rather than "operations", and
 * because the aggregate can never be rebuilt, the pollution would be permanent.
 * Excluding now is reversible; including now is not. An approval also moves no
 * value and has no meaningful amount or USD figure, so it buys no explorer
 * value to set against that cost. AgentScan's contract rejects both roles at
 * ingest on every kind, so emitting them would only earn a terminal validation
 * refusal.
 *
 * Two guards, because neither alone is enough. `satisfies` makes a value that
 * is not in the vocabulary a COMPILE error (membership), and the lockstep test
 * makes a vocabulary addition nobody made a reporting decision about a FAILING
 * test (completeness) — a union cannot be asserted at runtime, and a list
 * cannot notice what was never added to it.
 *
 * Widening these lists is the SECOND half of a rollout: AgentScan must already
 * accept a value before Vex may emit it (see the outbox status CHECK, migration
 * 076).
 */
export const REPORTED_KINDS = [
  "swap", "bridge", "lend", "prediction", "wrap", "yield", "launch",
] as const satisfies readonly AgentActivityKind[];

export const REPORTED_ROLES = [
  "swap",
  "bridge_deposit", "bridge_fee", "bridge_fill_expected", "bridge_fill_observed", "bridge_refund",
  "lend_deposit", "lend_withdraw", "lend_borrow_operate",
  "predict_buy", "predict_sell", "predict_claim", "predict_close",
  "wrap", "unwrap",
  "yield_pt", "yield_yt", "yield_py", "yield_lp", "yield_sy", "yield_claim",
  "token_launch", "trench_fee", "swap_fee",
] as const satisfies readonly AgentActivityEventRole[];

/**
 * `superseded_unproven` is reported as a fourth TERMINAL, NON-FAILURE status.
 * The mapper emits no `failureCode` for it (it is neither `confirmed` nor
 * `definitively_failed`), which is exactly its meaning: no longer in flight,
 * outcome unproven.
 */
export const REPORTED_STATUSES = [
  "pending", "confirmed", "definitively_failed", "superseded_unproven",
] as const satisfies readonly AgentActivityStatus[];

function sqlLiteralList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(",");
}

/**
 * The eligibility predicate — the single source of truth for what is reportable
 * at all, built from the lists above so the scan can never drift from them.
 */
const ELIGIBILITY_SQL = `
      a.kind IN (${sqlLiteralList(REPORTED_KINDS)})
  AND a.event_role IN (${sqlLiteralList(REPORTED_ROLES)})
  AND a.status IN (${sqlLiteralList(REPORTED_STATUSES)})
  AND a.chain_family IN ('eip155','solana')`;

/** Exponential claim backoff: 30 s · 2^n, capped at 1 h (exponent clamped so POWER stays finite). */
const CLAIM_BACKOFF_SQL = `LEAST(30 * POWER(2, LEAST(o.attempt_count, 20)), 3600)`;

async function ensureSingleton(): Promise<void> {
  await execute(
    `INSERT INTO agentscan_reporting_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
  );
}

interface StateRow {
  agent_hash: string | null;
  ingest_token: string | null;
  consent_version: number;
  accepted_at: Date | null;
  registered_at: Date | null;
  register_attempt_count: number;
  next_register_attempt_at: Date;
  backfill_enqueued_at: Date | null;
  stopped_reason: AgentscanStopReason | null;
  agent_name: string | null;
  last_handshake_at: Date | null;
  server_cursor_row_id: string | number | null;
  bound_wallets_fingerprint: string | null;
}

function mapState(row: StateRow): AgentscanReportingState {
  return {
    agentHash: row.agent_hash,
    ingestToken: row.ingest_token,
    consentVersion: Number(row.consent_version),
    acceptedAt: row.accepted_at ? new Date(row.accepted_at).toISOString() : null,
    registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
    registerAttemptCount: Number(row.register_attempt_count),
    nextRegisterAttemptAt: new Date(row.next_register_attempt_at).toISOString(),
    backfillEnqueuedAt: row.backfill_enqueued_at ? new Date(row.backfill_enqueued_at).toISOString() : null,
    stoppedReason: row.stopped_reason,
    agentName: row.agent_name,
    lastHandshakeAt: row.last_handshake_at ? new Date(row.last_handshake_at).toISOString() : null,
    serverCursorRowId: row.server_cursor_row_id === null ? null : Number(row.server_cursor_row_id),
    boundWalletsFingerprint: row.bound_wallets_fingerprint,
  };
}

export async function getReportingState(): Promise<AgentscanReportingState> {
  await ensureSingleton();
  const row = await queryOne<StateRow>(`SELECT * FROM agentscan_reporting_state WHERE id = 1`);
  if (!row) throw new Error("agentscan_reporting_state singleton missing after ensure");
  return mapState(row);
}

/**
 * Store an identity IF none exists yet; an already-stored identity always
 * wins. The `agent_hash IS NULL` guard (not a read-then-write) is what makes
 * concurrent callers safe — exactly one generator result is ever persisted.
 */
export async function ensureIdentity(
  gen: () => { agentHash: string; ingestToken: string },
): Promise<AgentscanReportingState> {
  await ensureSingleton();
  const identity = gen();
  await execute(
    `UPDATE agentscan_reporting_state
        SET agent_hash = $1, ingest_token = $2, accepted_at = NOW(), updated_at = NOW()
      WHERE id = 1 AND agent_hash IS NULL`,
    [identity.agentHash, identity.ingestToken],
  );
  return getReportingState();
}

export interface MarkHandshakeCompleteInput {
  /** Display name AgentScan bound to this install (session/complete response). */
  readonly agentName: string;
  /** The ROTATED token session/complete returned — replaces whatever was stored. */
  readonly ingestToken: string;
  /** session/complete's syncState.lastAcceptedRowId — null for a brand-new agent. */
  readonly serverCursorRowId: number | null;
  /** sha256 of the sorted chainFamily:address inventory list this handshake covered. */
  readonly walletsFingerprint: string;
}

/**
 * A successful wallet-binding handshake (session/start → sign → session/complete):
 * rotate the stored token, stamp `registered_at` (kept in sync so the existing
 * backfill/drain gate needs no change) and `last_handshake_at`, store the
 * server's name/cursor/fingerprint, and reset the attempt backoff to 0/now —
 * a stale attempt count from a PRIOR failed handshake must not throttle the
 * NEXT one this success has nothing to do with.
 */
export async function markHandshakeComplete(input: MarkHandshakeCompleteInput): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET ingest_token = $1,
            agent_name = $2,
            server_cursor_row_id = $3,
            bound_wallets_fingerprint = $4,
            registered_at = NOW(),
            last_handshake_at = NOW(),
            register_attempt_count = 0,
            next_register_attempt_at = NOW(),
            updated_at = NOW()
      WHERE id = 1`,
    [input.ingestToken, input.agentName, input.serverCursorRowId, input.walletsFingerprint],
  );
}

/** A failed register attempt: bump the counter, hold the next try for `delaySeconds`. */
export async function noteRegisterAttemptFailed(delaySeconds: number): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET register_attempt_count = register_attempt_count + 1,
            next_register_attempt_at = NOW() + make_interval(secs => $1::float8),
            updated_at = NOW()
      WHERE id = 1`,
    [delaySeconds],
  );
}

/**
 * Shared by `resetForReRegistration` and `resetIdentityForRecovery`: every
 * already-sent row becomes owed again, flagged `backfill` (a historical
 * resend, not fresh activity). Poisoned rows (`rejected_at`) stay poisoned —
 * a validation refusal the server made once does not become valid by
 * resending the identical payload. Caller runs this inside its own
 * transaction alongside its own state reset, so a crash can't leave one half
 * applied.
 */
async function resetOutboxForFullResend(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE agentscan_outbox
        SET sent_at = NULL, attempt_count = 0, next_attempt_at = NOW(), backfill = TRUE, last_error = NULL
      WHERE sent_at IS NOT NULL`,
  );
}

/**
 * `auth_lost` recovery (401/403-not_registered on send): the server no longer
 * knows this install (a server-side reset is the expected cause), so it also
 * has none of the history this install already sent. Registration is
 * idempotent — the lane simply re-registers the SAME identity next tick — but
 * the diff scan's NOT-EXISTS can never re-enqueue a pair that already has an
 * outbox row, so a full resend has to come from resetting the existing rows,
 * not from re-scanning. The identity itself (agent_hash/ingest_token) is left
 * untouched: this path is for when the SERVER has forgotten the install, not
 * for when the CLIENT's stored token has drifted from what the server
 * actually holds (that case is `resetIdentityForRecovery`, below).
 */
export async function resetForReRegistration(): Promise<void> {
  await ensureSingleton();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentscan_reporting_state
          SET registered_at = NULL, backfill_enqueued_at = NULL, updated_at = NOW()
        WHERE id = 1`,
    );
    await resetOutboxForFullResend(client);
  });
}

/**
 * `auth_lost` recovery for a session/complete `401` on an EXISTING binding
 * (token mismatch): unlike `resetForReRegistration`, this is NOT recoverable
 * by retrying the same identity, because the server holds SOME current token
 * for this agent_hash that this install does not know (the canonical cause:
 * a crash between the server committing a rotation and this install
 * persisting it via `markHandshakeComplete` — the next handshake attempt
 * would keep presenting the same stale bearer forever, an infinite 401 loop).
 * The only way out is to abandon the identity entirely: clear agent_hash,
 * ingest_token, agent_name, bound_wallets_fingerprint, and every
 * registration/backfill/handshake stamp, and reset the attempt backoff so
 * the next tick retries immediately. `ensureIdentity` then mints a FRESH
 * agent_hash/ingest_token next run, and the server's transfer-on-proof
 * semantics (sprint lead addendum) re-bind the same proven wallets to it —
 * that is the designed recovery, not a data-loss path. The outbox reset is
 * the same full-resend as `resetForReRegistration`, in the same transaction.
 */
export async function resetIdentityForRecovery(): Promise<void> {
  await ensureSingleton();
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE agentscan_reporting_state
          SET agent_hash = NULL,
              ingest_token = NULL,
              agent_name = NULL,
              bound_wallets_fingerprint = NULL,
              registered_at = NULL,
              backfill_enqueued_at = NULL,
              last_handshake_at = NULL,
              server_cursor_row_id = NULL,
              register_attempt_count = 0,
              next_register_attempt_at = NOW(),
              updated_at = NOW()
        WHERE id = 1`,
    );
    await resetOutboxForFullResend(client);
  });
}

/** Permanent stop — 410, 403-quarantined, or a register 409. Never auto-cleared. */
export async function markStopped(reason: AgentscanStopReason): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET stopped_reason = $1, stopped_at = NOW(), updated_at = NOW()
      WHERE id = 1`,
    [reason],
  );
}

export async function markBackfillEnqueued(): Promise<void> {
  await ensureSingleton();
  await execute(
    `UPDATE agentscan_reporting_state
        SET backfill_enqueued_at = NOW(), updated_at = NOW()
      WHERE id = 1`,
  );
}

/**
 * The diff scan. Inserts every eligible (activity, status) pair the outbox has
 * never seen; returns how many were enqueued. `backfill` stamps the rows as
 * belonging to the one-time post-registration history send.
 */
export async function enqueueEligibleActivity(backfill: boolean): Promise<number> {
  return execute(
    `INSERT INTO agentscan_outbox (activity_id, status, backfill)
     SELECT a.id, a.status, $1
       FROM agent_activity a
      WHERE ${ELIGIBILITY_SQL}
        AND NOT EXISTS (SELECT 1 FROM agentscan_outbox o
                         WHERE o.activity_id = a.id AND o.status = a.status)
     ON CONFLICT (activity_id, status) DO NOTHING`,
    [backfill],
  );
}

/**
 * Claim up to `limit` due rows (backfill first, then oldest), stamping the
 * retry backoff before the caller sends. Returns each claimed pair with its
 * live `agent_activity` row for payload building.
 */
export async function claimDueOutbox(limit: number): Promise<ClaimedOutboxEvent[]> {
  const claimed = await query<{
    id: string | number;
    activity_id: string | number;
    status: ClaimedOutboxEvent["status"];
    backfill: boolean;
  }>(
    `WITH claimed AS (
       SELECT o.id FROM agentscan_outbox o
        WHERE o.sent_at IS NULL AND o.rejected_at IS NULL AND o.next_attempt_at <= NOW()
        ORDER BY o.backfill DESC, o.id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE agentscan_outbox o
        SET attempt_count = o.attempt_count + 1,
            next_attempt_at = NOW() + make_interval(secs => ${CLAIM_BACKOFF_SQL}),
            last_error = NULL
       FROM claimed
      WHERE o.id = claimed.id
     RETURNING o.id, o.activity_id, o.status, o.backfill`,
    [limit],
  );
  if (claimed.length === 0) return [];

  const activityIds = [...new Set(claimed.map((c) => Number(c.activity_id)))];
  const activityRows = await query<Record<string, unknown>>(
    `SELECT * FROM agent_activity WHERE id = ANY($1::bigint[])`,
    [activityIds],
  );
  const byId = new Map(activityRows.map((r) => [Number(r.id), r]));

  return claimed.map((c) => ({
    outboxId: Number(c.id),
    activityId: Number(c.activity_id),
    status: c.status,
    backfill: c.backfill,
    activity: byId.get(Number(c.activity_id)) ?? null,
  }));
}

/** Server accepted (or deduplicated) these events — terminal, never resent. */
export async function markOutboxSent(outboxIds: number[]): Promise<void> {
  if (outboxIds.length === 0) return;
  await execute(
    `UPDATE agentscan_outbox
        SET sent_at = NOW(), last_error = NULL
      WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND rejected_at IS NULL`,
    [outboxIds],
  );
}

/** Server's per-item validation refusal — terminal; retrying an identical payload can only refail. */
export async function markOutboxRejected(outboxId: number, error: string): Promise<void> {
  await execute(
    `UPDATE agentscan_outbox
        SET rejected_at = NOW(), last_error = $2
      WHERE id = $1 AND sent_at IS NULL AND rejected_at IS NULL`,
    [outboxId, error.slice(0, 200)],
  );
}

/** Override the stamped backoff (e.g. the server's own Retry-After) for still-owed rows. */
export async function rescheduleOutbox(outboxIds: number[], delaySeconds: number): Promise<void> {
  if (outboxIds.length === 0) return;
  await execute(
    `UPDATE agentscan_outbox
        SET next_attempt_at = NOW() + make_interval(secs => $2::float8)
      WHERE id = ANY($1::bigint[]) AND sent_at IS NULL AND rejected_at IS NULL`,
    [outboxIds, delaySeconds],
  );
}
