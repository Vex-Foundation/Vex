/**
 * WP8 - the SERIALIZED PUBLICATION GATE for portfolio snapshots.
 *
 * ## The invariant
 *
 * A `proj_portfolio_snapshots` row is the BASELINE every later profit-and-loss
 * figure is measured against. A snapshot written while a transaction is in
 * flight records a portfolio that is half pre-trade and half post-trade, and
 * that corruption is not local: it propagates through `pnl_vs_prev` into every
 * subsequent cycle. A MISSING snapshot is recoverable - the next cycle takes
 * one. A WRONG snapshot is not. The gate is therefore FAIL-CLOSED in every
 * direction: an ambiguous row, an unreadable probe and an unavailable lock all
 * mean "do not publish", never "publish anyway".
 *
 * ## Why a table lock and not a re-read
 *
 * The defect this replaces read `hasPendingActivityForWallets` ONCE, minutes
 * before the insert. Moving that read inside the publishing transaction is not
 * enough on its own: a writer that commits an instant after our predicate
 * evaluates is invisible to it, and READ COMMITTED gives us no protection
 * against a row that did not exist when we looked. Only a lock that CONFLICTS
 * with the writers turns the predicate into a boundary.
 *
 * `LOCK TABLE agent_activity IN SHARE MODE` conflicts with the `ROW EXCLUSIVE`
 * lock every INSERT/UPDATE takes, so for the (short) life of the publishing
 * transaction no activity row can be written for ANY wallet. Once we hold it,
 * "no pending activity" is true and STAYS true until we commit.
 *
 * The table lock was chosen DELIBERATELY over per-wallet advisory locks: an
 * advisory scheme is only safe once all of `agent_activity`'s writers agree on
 * a global lock order, and inventing that ordering is a far larger money-path
 * risk than a sub-second exclusive window on one table.
 *
 * SHARE mode is self-compatible, so this lock does NOT serialize two concurrent
 * PUBLISHERS against each other. That is deliberate too: publisher-vs-publisher
 * is already excluded in-process by `./single-flight.ts`, and widening to
 * EXCLUSIVE would block activity readers for no additional safety.
 *
 * ## The transition fence
 *
 * The lock closes the "writer commits after my check" race. It does NOT close a
 * second one: a transaction that BEGINS and SETTLES entirely inside the
 * multi-wallet scan leaves nothing pending at publication time, yet the wallets
 * scanned before it and the wallets scanned after it were read on opposite
 * sides of a money movement. The resulting group would mix pre-transaction and
 * post-transaction balances and look perfectly settled.
 *
 * `readActivityFence` therefore stamps the activity table's generation at cycle
 * start and the gate compares it against the value observed under the lock. Any
 * INSERT moves `max_id`, any status transition moves `max_updated_at`, so a
 * transaction that came and went during the scan is caught even though it is
 * long gone by the time we look for pending rows.
 *
 * ## Unresolved intents NEVER time-release (owner decision, not a build choice)
 *
 * An intent whose outcome we cannot prove keeps blocking, for as long as it
 * stays unproven. `UNRECONCILED_AFTER_MS` exists ONLY to escalate the report -
 * it marks a blocker as needing operator attention. It must never be turned
 * into a release condition. Unknown money state is the repo's existing
 * fail-closed doctrine (`db/repos/approval-intents/money-state.ts`), and the
 * predicates below are the wallet-scoped reading of that same reader.
 *
 * ## Known scope limit
 *
 * `protocol_executions.execution_status = 'intent'` is in the session-scoped
 * money-state reader but NOT here: that table carries no `wallet_address`, so
 * it cannot be scoped to this cycle's wallets, and a global scan would block
 * every wallet's snapshot on an unrelated session's row. Every such intent that
 * reaches a broadcast writes an `agent_activity` row, which predicate 1 sees.
 */

import type { Executor } from "@vex-agent/db/client.js";

/**
 * Age at which a still-blocking row stops being "a transaction in progress" and
 * becomes "something a human should look at". It raises the report's severity;
 * it NEVER releases publication.
 */
export const UNRECONCILED_AFTER_MS = 15 * 60 * 1000;

/** Bounded: the decision is binary, so the count of reasons cannot change it. */
const MAX_BLOCKERS = 50;

/** Why a snapshot group may not be published right now. One row per in-flight thing. */
export interface PublicationBlocker {
  readonly kind:
    | "agent_activity_pending"
    | "wallet_intent_live"
    | "wallet_confirmation_unknown"
    | "wallet_transaction_intent_live"
    | "wallet_transaction_confirmation_unknown"
    | "wallet_wrap_intent_live"
    | "wallet_wrap_confirmation_unknown";
  /** Identifier of the blocking row, for audit and operator diagnosis. */
  readonly ref: string;
  /** Structural label only (a status or a role) - never provider text. */
  readonly detail: string | null;
  /** Seconds since the blocking row was created. */
  readonly ageSeconds: number;
  /** `ageSeconds` has passed `UNRECONCILED_AFTER_MS`. Escalation, not release. */
  readonly unreconciled: boolean;
}

/**
 * The activity table's generation for one wallet set. Compared by VALUE, so
 * every component is read back as a stable string rather than a driver-typed
 * `Date`/`BigInt` whose equality depends on the pg type parser.
 */
export interface ActivityFence {
  readonly maxId: string;
  readonly maxUpdatedAt: string;
  readonly rowCount: string;
}

interface FenceRow {
  max_id: string;
  max_updated_at: string;
  row_count: string;
}

const FENCE_SQL = `
  SELECT COALESCE(MAX(id), 0)::text                                AS max_id,
         COALESCE(MAX(updated_at), 'epoch'::timestamptz)::text     AS max_updated_at,
         COUNT(*)::text                                            AS row_count
    FROM agent_activity
   WHERE wallet_address = ANY($1::text[])`;

/**
 * Stamp the activity generation for `walletAddresses`. Call this BEFORE the
 * scan starts; the same value is handed to `readPublicationBlockers`'s caller
 * so the gate can prove nothing moved in between.
 */
export async function readActivityFence(
  executor: Executor,
  walletAddresses: readonly string[],
): Promise<ActivityFence> {
  const res = await executor.query<FenceRow>(FENCE_SQL, [[...walletAddresses]]);
  const row = res.rows[0];
  return {
    maxId: row?.max_id ?? "0",
    maxUpdatedAt: row?.max_updated_at ?? "epoch",
    rowCount: row?.row_count ?? "0",
  };
}

export function fencesMatch(a: ActivityFence, b: ActivityFence): boolean {
  return a.maxId === b.maxId
    && a.maxUpdatedAt === b.maxUpdatedAt
    && a.rowCount === b.rowCount;
}

/**
 * Seven wallet-scoped predicates, one round trip. Each is the wallet-scoped
 * reading of the correspondingly named predicate in
 * `db/repos/approval-intents/money-state.ts`; the release/block decisions are
 * that module's, deliberately not re-derived here.
 *
 *  1. `agent_activity` PENDING - a broadcast awaiting confirmation.
 *  2. `wallet_intents` `consuming`, or `pending` that has NOT expired. An
 *     EXPIRED `pending` is dead (the CAS filters on `expires_at > NOW()`), so
 *     it can never be claimed and must not block forever.
 *  3. `wallet_intents` hash-carrying rows in a state that does not prove an
 *     outcome. A legacy `failed`-with-hash row releases ONLY when its linked
 *     activity proves a mined revert.
 *  4/5. `wallet_transaction_intents` (migration 087), read the same way, plus
 *     the hash-carrying defence in depth: a status added to the CHECK without a
 *     thought for this gate must not silently release a staged hash.
 *  6/7. `wallet_wrap_intents` (migration 096), identical reading. Its own
 *     `review_required` - the receipt proved a quantity CONTRADICTING the
 *     approved amount - blocks until a human closes it: the chain event is over
 *     while the money question is not.
 */
const BLOCKERS_SQL = `
  SELECT 'agent_activity_pending'::text AS kind, a.id::text AS ref,
         a.event_role::text AS detail, a.created_at AS since
    FROM agent_activity a
   WHERE a.wallet_address = ANY($1::text[]) AND a.status = 'pending'

   UNION ALL

  SELECT 'wallet_intent_live', w.intent_id::text, w.status::text, w.created_at
    FROM wallet_intents w
   WHERE w.wallet_address = ANY($1::text[])
     AND (w.status = 'consuming' OR (w.status = 'pending' AND w.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_confirmation_unknown', w.intent_id::text, w.status::text, w.created_at
    FROM wallet_intents w
   WHERE w.wallet_address = ANY($1::text[])
     AND w.tx_hash IS NOT NULL
     AND (
       w.status IN ('broadcast_unconfirmed', 'review_required', 'audit_failed')
       OR (
         w.status = 'failed'
         AND w.failure_reason IS DISTINCT FROM 'RepairLane:chain_reverted'
         AND NOT EXISTS (
           SELECT 1 FROM agent_activity a2
            WHERE a2.id = w.activity_id
              AND a2.event_role = 'wallet_transfer'
              AND a2.tx_hash = w.tx_hash
              AND a2.status = 'definitively_failed'
              AND a2.failure_code = 'mined_revert'
         )
       )
     )

   UNION ALL

  SELECT 'wallet_transaction_intent_live', t.intent_id::text, t.status::text, t.created_at
    FROM wallet_transaction_intents t
   WHERE t.wallet_address = ANY($1::text[])
     AND (t.status IN ('consuming', 'broadcast_unconfirmed')
          OR (t.status = 'pending' AND t.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_transaction_confirmation_unknown', t.intent_id::text, t.status::text, t.created_at
    FROM wallet_transaction_intents t
   WHERE t.wallet_address = ANY($1::text[])
     AND t.tx_hash IS NOT NULL
     AND t.status NOT IN ('executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed')

   UNION ALL

  SELECT 'wallet_wrap_intent_live', w2.intent_id::text, w2.status::text, w2.created_at
    FROM wallet_wrap_intents w2
   WHERE w2.wallet_address = ANY($1::text[])
     AND (w2.status IN ('consuming', 'broadcast_unconfirmed', 'review_required')
          OR (w2.status = 'pending' AND w2.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_wrap_confirmation_unknown', w2.intent_id::text, w2.status::text, w2.created_at
    FROM wallet_wrap_intents w2
   WHERE w2.wallet_address = ANY($1::text[])
     AND w2.tx_hash IS NOT NULL
     AND w2.status NOT IN (
           'executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed', 'review_required'
         )

   LIMIT $2`;

interface BlockerRow {
  kind: PublicationBlocker["kind"];
  ref: string;
  detail: string | null;
  since: Date | string | null;
}

/**
 * Read every reason publication must be withheld, INSIDE the caller's
 * transaction and AFTER the caller has taken the activity table lock. Read
 * outside that lock the answer is stale the instant it returns, which is the
 * exact defect this module exists to close - hence the required `Executor`.
 */
export async function readPublicationBlockers(
  executor: Executor,
  walletAddresses: readonly string[],
  now: number = Date.now(),
): Promise<readonly PublicationBlocker[]> {
  if (walletAddresses.length === 0) return [];
  const res = await executor.query<BlockerRow>(BLOCKERS_SQL, [[...walletAddresses], MAX_BLOCKERS]);
  return res.rows.map((row) => {
    const ageSeconds = toAgeSeconds(row.since, now);
    return {
      kind: row.kind,
      ref: row.ref,
      detail: row.detail,
      ageSeconds,
      unreconciled: ageSeconds * 1000 >= UNRECONCILED_AFTER_MS,
    };
  });
}

function toAgeSeconds(since: Date | string | null, now: number): number {
  if (since === null) return 0;
  const ms = since instanceof Date ? since.getTime() : Date.parse(since);
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((now - ms) / 1000));
}
