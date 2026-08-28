/**
 * Unresolved money state for ONE session — the safe-moment gate for the
 * compaction-v2 APPLY cutover (wave contract C7).
 *
 * ## What this answers
 *
 * "Is there anything in flight for this session that could still move funds, or
 * whose outcome we cannot yet prove?" A `clear: true` answer is a licence to
 * rewrite the session's transcript out from under the runtime; anything less is
 * a deferral. It is therefore written to FAIL CLOSED: an ambiguous row blocks.
 *
 * ## Why it is NOT `getPendingLifecycleForSession`
 *
 * That reader (`./lifecycle.ts`) exists to answer a different question — "which
 * approvals can the deferred-resume worker act on RIGHT NOW" — and its
 * `RESUMABLE_SHAPES_PREDICATE` is load-bearing for approval resume. Widening it
 * to cover the money gate would change which approvals the runtime tries to
 * resume, which is a live money-path behaviour change with nothing to do with
 * compaction. Two questions, two readers, one table.
 *
 * Concretely it misses, on purpose, states this gate MUST see: `dispatching`
 * and `indeterminate` approvals (both are unproven money-path outcomes), and
 * everything outside `approval_intents` entirely.
 *
 * ## Why every predicate is included
 *
 *  1. `approval_queue` PENDING — a decision the operator has not made yet.
 *     Queried FIRST (not through a join from `approval_intents`) because legacy
 *     rows predate the intents table: an intent-first join cannot see a pending
 *     queue row that has no intent, and would report `clear` while an approval
 *     sits on the operator's screen.
 *  2. `approval_intents.decision IS NULL` with no pending queue row — our audit
 *     row says undecided while the queue says otherwise. Unproven, so it blocks.
 *  3. `approved` + `execution_status IN ('not_started','dispatching',
 *     'indeterminate')` — approved-but-not-finished. `dispatching` is a tool
 *     call in flight; `indeterminate` (migration 056) is the honest "we cannot
 *     prove what happened" verdict and is exactly the state a transcript
 *     rewrite must not race.
 *  4. `wallet_intents` `consuming`, or `pending` that has NOT expired. An
 *     EXPIRED `pending` is dead — `consumeIfPending` filters on
 *     `expires_at > NOW()`, so it can never be claimed — and must not block.
 *  5. `wallet_intents` `broadcast_unconfirmed` / `review_required`, or an
 *     `audit_failed` row carrying a hash. These are named unresolved outcomes.
 *     A legacy `failed` row with a hash releases only when its linked activity
 *     proves a mined revert; every other such row still fails closed.
 *  6. `wallet_transaction_intents` (migration 087) `consuming`,
 *     `broadcast_unconfirmed`, or `pending` that has NOT expired. Same reading
 *     as 4 with one addition the transfer table cannot express:
 *     `broadcast_unconfirmed` is the DISTINCT durable status for "the bytes are
 *     on the network and we cannot yet prove the outcome", which is precisely
 *     an unresolved money state and blocks until a repair lane settles it
 *     (T5/T6). `superseded_unproven` and `audit_failed` RELEASE: the first is an
 *     honest terminal the repair lane wrote, the second means the staged-evidence
 *     write failed BEFORE broadcast, so nothing was signed.
 *  7. `wallet_transaction_intents` carrying a `tx_hash` in ANY state outside the
 *     proven-terminal set. Defence in depth rather than a live predicate: the
 *     migration's evidence CHECK already makes every hash-carrying status either
 *     proven or covered by 6. It is written out anyway because a future status
 *     added to the CHECK without a thought for this gate would otherwise release
 *     a staged hash silently, and that is exactly the failure mode the transfer
 *     table's weaker CHECK produced.
 *  8. `wallet_wrap_intents` (migration 096) `consuming`,
 *     `broadcast_unconfirmed`, `review_required`, or `pending` that has NOT
 *     expired, plus the same hash-carrying defence in depth as 7. The wrap
 *     table is read like the transaction table - `superseded_unproven` and
 *     `audit_failed` RELEASE, everything unproven blocks - and it is a SEPARATE
 *     state machine with its own table, so omitting it here would let a
 *     compaction cutover rewrite the transcript while a wrap was mid-flight.
 *
 *     `review_required` is the wrap table's OWN addition and blocks for a
 *     reason worth naming: the transaction CONFIRMED, but its receipt proved a
 *     quantity that CONTRADICTS the approved amount. The chain event is over
 *     while the MONEY QUESTION is not, and only a human closes it. It reads
 *     exactly like `wallet_intents.review_required` in predicate 5.
 *  9. `protocol_executions.execution_status = 'intent'` - a durable pre-sign
 *     record whose exchange outcome was never written back.
 * 10. `agent_activity.status = 'pending'` - a broadcast awaiting confirmation.
 *
 * KNOWN GAP (owner decision pending, not a build choice): `protocol_executions`
 * `session_id` is nullable, so an intent row created without a session is
 * invisible to this session-scoped reader. Widening to a global scan would
 * block unrelated sessions, which is worse.
 *
 * ## Client-bound by construction
 *
 * There is deliberately NO pool-level variant. This reader is only meaningful
 * inside the caller's transaction, under the session control lock — read
 * outside it, the answer is stale the instant it returns. Making the client a
 * required parameter is what stops that misuse at compile time.
 *
 * ## WRITER-SIDE CONTRACT (the half that makes the reader true)
 *
 * A reader under a lock proves nothing unless the WRITERS take the same lock.
 * Every writer that moves a row into or out of the sets above MUST, in ONE
 * short DB-only transaction:
 *
 *   1. `acquireSessionControlLock(client, sessionId)` FIRST — the global lock
 *      order in `engine/runtime/lease-and-status/session-control-lock.ts`
 *      applies unchanged, and this lock is always edge 0;
 *   2. perform the CAS;
 *   3. COMMIT — BEFORE any provider, wallet or signing call.
 *
 * Step 3 is not a style preference. A writer that held this lock across a
 * signing call would block the operator's Stop, which is the exact inversion
 * the lock exists to prevent (see that module's hold-duration section).
 *
 * The consequence is a strict order rather than an interleaving: either the
 * gate saw the writer's row and deferred the cutover, or the writer's row
 * landed strictly after the cutover committed. Each participating writer has
 * its own two-client interleaving test proving that; mocked SQL cannot.
 */

import type { PoolClient } from "pg";

/** Why the session is not at a safe moment. One row per in-flight thing. */
export interface MoneyStateReason {
  kind:
    | "approval_queue_pending"
    | "approval_in_flight"
    | "wallet_intent_live"
    | "wallet_confirmation_unknown"
    | "wallet_transaction_intent_live"
    | "wallet_transaction_confirmation_unknown"
    | "wallet_wrap_intent_live"
    | "wallet_wrap_confirmation_unknown"
    | "protocol_execution_intent"
    | "agent_activity_pending";
  /** Identifier of the blocking row, for audit and operator diagnosis. */
  ref: string;
  /** Structural label only — never a raw provider message or user content. */
  detail?: string;
}

export type UnresolvedMoneyState =
  | { clear: true }
  | { clear: false; reasons: readonly MoneyStateReason[] };

/**
 * Bounded so the gate is a single round trip of predictable cost inside the
 * lock. The answer is binary — 50 reasons and 500 reasons both mean "defer" —
 * so truncation cannot change the decision, only the audit detail.
 */
const MAX_REASONS = 50;

/**
 * One statement, eleven session-scoped predicates. Every branch hits a
 * session-scoped index (`idx_approvals_session`, `idx_wallet_intents_session`,
 * `idx_wallet_transaction_intents_session`, `idx_wallet_wrap_intents_session`,
 * `idx_executions_session`,
 * `idx_agent_activity_pending`), because this runs on
 * the critical path of every apply while the session control lock is held.
 */
const UNRESOLVED_MONEY_STATE_SQL = `
  SELECT 'approval_queue_pending'::text AS kind, q.id::text AS ref, 'queue_pending'::text AS detail
    FROM approval_queue q
   WHERE q.session_id = $1 AND q.status = 'pending'

   UNION ALL

  SELECT 'approval_queue_pending', i.approval_id::text, 'intent_undecided'
    FROM approval_intents i
   WHERE i.session_id = $1
     AND i.decision IS NULL
     AND NOT EXISTS (
           SELECT 1 FROM approval_queue q2
            WHERE q2.id = i.approval_id AND q2.status = 'pending'
         )

   UNION ALL

  SELECT 'approval_in_flight', i.approval_id::text, i.execution_status::text
    FROM approval_intents i
   WHERE i.session_id = $1
     AND i.decision = 'approved'
     AND i.execution_status IN ('not_started', 'dispatching', 'indeterminate')

   UNION ALL

  SELECT 'wallet_intent_live', w.intent_id::text, w.status::text
    FROM wallet_intents w
   WHERE w.session_id = $1
     AND (w.status = 'consuming' OR (w.status = 'pending' AND w.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_confirmation_unknown', w.intent_id::text, w.status::text
    FROM wallet_intents w
   WHERE w.session_id = $1
     AND w.tx_hash IS NOT NULL
     AND (
       w.status IN ('broadcast_unconfirmed', 'review_required', 'audit_failed')
       OR (
         w.status = 'failed'
         AND w.failure_reason IS DISTINCT FROM 'RepairLane:chain_reverted'
         AND NOT EXISTS (
           SELECT 1
             FROM agent_activity a
            WHERE a.id = w.activity_id
              AND a.session_id = w.session_id
              AND a.event_role = 'wallet_transfer'
              AND a.tx_hash = w.tx_hash
              AND a.status = 'definitively_failed'
              AND a.failure_code = 'mined_revert'
         )
       )
     )

   UNION ALL

  SELECT 'wallet_transaction_intent_live', t.intent_id::text, t.status::text
    FROM wallet_transaction_intents t
   WHERE t.session_id = $1
     AND (t.status IN ('consuming', 'broadcast_unconfirmed')
          OR (t.status = 'pending' AND t.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_transaction_confirmation_unknown', t.intent_id::text, t.status::text
    FROM wallet_transaction_intents t
   WHERE t.session_id = $1
     AND t.tx_hash IS NOT NULL
     AND t.status NOT IN ('executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed')

   UNION ALL

  SELECT 'wallet_wrap_intent_live', w2.intent_id::text, w2.status::text
    FROM wallet_wrap_intents w2
   WHERE w2.session_id = $1
     AND (w2.status IN ('consuming', 'broadcast_unconfirmed', 'review_required')
          OR (w2.status = 'pending' AND w2.expires_at > NOW()))

   UNION ALL

  SELECT 'wallet_wrap_confirmation_unknown', w2.intent_id::text, w2.status::text
    FROM wallet_wrap_intents w2
   WHERE w2.session_id = $1
     AND w2.tx_hash IS NOT NULL
     AND w2.status NOT IN (
           'executed', 'failed', 'superseded_unproven', 'broadcast_unconfirmed', 'review_required'
         )

   UNION ALL

  SELECT 'protocol_execution_intent', e.id::text, e.tool_id::text
    FROM protocol_executions e
   WHERE e.session_id = $1 AND e.execution_status = 'intent'

   UNION ALL

  SELECT 'agent_activity_pending', a.id::text, a.event_role::text
    FROM agent_activity a
   WHERE a.session_id = $1 AND a.status = 'pending'

   LIMIT $2`;

/**
 * Read every unresolved money-path row for `sessionId` inside the CALLER's
 * transaction. See the module header for the writer-side obligation that makes
 * the answer a boundary rather than a snapshot of the past.
 */
export async function getUnresolvedMoneyStateForSession(
  client: PoolClient,
  sessionId: string,
): Promise<UnresolvedMoneyState> {
  const res = await client.query<{
    kind: MoneyStateReason["kind"];
    ref: string;
    detail: string | null;
  }>(UNRESOLVED_MONEY_STATE_SQL, [sessionId, MAX_REASONS]);

  if (res.rows.length === 0) {
    return { clear: true };
  }

  const reasons: MoneyStateReason[] = res.rows.map((row) => ({
    kind: row.kind,
    ref: row.ref,
    ...(row.detail === null ? {} : { detail: row.detail }),
  }));
  return { clear: false, reasons };
}
