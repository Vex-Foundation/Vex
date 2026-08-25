-- 093_wallet_transfer_unconfirmed_repair.sql - transfer ambiguity has an owner
--
-- RUNS AFTER 092.
--
-- A wallet send that returned `confirmation_unknown` used to become
-- `wallet_intents.status = 'failed'` while carrying a transaction hash. The
-- independently durable `agent_activity` wallet_transfer row stayed pending and
-- was observed by the existing EVM or Solana repair lane, but there was no link
-- by which that verdict could settle the transfer intent. The compaction money
-- gate therefore blocked forever even after the chain outcome was known.
--
-- New sends atomically link their intent to the one wallet_transfer activity
-- before signing. Ambiguity is `broadcast_unconfirmed`; the activity observer
-- moves both rows to a compatible terminal state in one session-locked
-- transaction. `superseded_unproven` preserves non-inclusion evidence without
-- claiming a revert.
--
-- Historical backfill is conservative:
--   1. Link only a unique same-session wallet_transfer execution whose stored
--      params name this exact intent.
--   2. Spend only an activity verdict whose staged hash matches the intent hash.
--   3. Keep a linked pending row as `broadcast_unconfirmed` for its existing
--      observer.
--   4. Put every remaining hash-carrying failed/audit row in the explicit
--      `review_required` queue. This covers pre-084 transfers that have no
--      activity row. The EVM and Solana sweeps observe that bounded queue by hash
--      without signing or rebroadcasting. Inconclusive rows remain named and
--      continue blocking the money gate.
--
-- Forward-only and idempotent.

ALTER TABLE wallet_intents
  ADD COLUMN IF NOT EXISTS activity_id BIGINT REFERENCES agent_activity(id) ON DELETE RESTRICT;

ALTER TABLE wallet_intents
  ADD COLUMN IF NOT EXISTS repair_checked_at TIMESTAMPTZ;

-- The old CHECK cannot admit the new backfill values. Restore the complete
-- vocabulary after every row has been classified below.
ALTER TABLE wallet_intents DROP CONSTRAINT IF EXISTS wallet_intents_status_check;

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_intents_activity_unique
  ON wallet_intents (activity_id)
  WHERE activity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_wallet_intents_review_queue
  ON wallet_intents (network, repair_checked_at, created_at, intent_id)
  WHERE status IN ('failed', 'audit_failed') AND tx_hash IS NOT NULL;

-- Link only one exact durable execution. `intent_id` is globally unique, but
-- the HAVING guard also refuses a duplicate execution history rather than
-- choosing one by row order.
WITH exact_activity AS (
  SELECT w.intent_id, MIN(a.id) AS activity_id
    FROM wallet_intents w
    JOIN protocol_executions e
      ON e.session_id = w.session_id
     AND e.params ->> 'intentId' = w.intent_id
    JOIN agent_activity a
      ON a.protocol_execution_id = e.id
     AND a.session_id = w.session_id
     AND a.event_role = 'wallet_transfer'
     AND a.kind = 'transfer'
   WHERE w.activity_id IS NULL
   GROUP BY w.intent_id
  HAVING COUNT(*) = 1
)
UPDATE wallet_intents w
   SET activity_id = x.activity_id
  FROM exact_activity x
 WHERE w.intent_id = x.intent_id
   AND w.activity_id IS NULL;

-- A terminal activity verdict is stronger than the old generic failed label.
UPDATE wallet_intents w
   SET status = 'executed', failure_reason = NULL
  FROM agent_activity a
 WHERE w.activity_id = a.id
   AND w.tx_hash IS NOT NULL
   AND a.tx_hash = w.tx_hash
   AND w.status IN ('failed', 'audit_failed')
   AND a.status = 'confirmed';

UPDATE wallet_intents w
   SET status = 'failed', failure_reason = 'RepairLane:chain_reverted'
  FROM agent_activity a
 WHERE w.activity_id = a.id
   AND w.tx_hash IS NOT NULL
   AND a.tx_hash = w.tx_hash
   AND w.status IN ('failed', 'audit_failed')
   AND a.status = 'definitively_failed'
   AND a.failure_code = 'mined_revert';

UPDATE wallet_intents w
   SET status = 'superseded_unproven', failure_reason = 'RepairLane:superseded_unproven'
  FROM agent_activity a
 WHERE w.activity_id = a.id
   AND w.tx_hash IS NOT NULL
   AND a.tx_hash = w.tx_hash
   AND w.status IN ('failed', 'audit_failed')
   AND (
     a.status = 'superseded_unproven'
     OR (a.status = 'definitively_failed' AND a.failure_code = 'solana_signature_expired')
   );

UPDATE wallet_intents w
   SET status = 'broadcast_unconfirmed'
  FROM agent_activity a
 WHERE w.activity_id = a.id
   AND w.tx_hash IS NOT NULL
   AND a.tx_hash = w.tx_hash
   AND w.status IN ('failed', 'audit_failed')
   AND a.status = 'pending';

-- Anything not classified above remains unresolved by name. This is the
-- bounded legacy queue, not a terminal failure and not permission to retry.
UPDATE wallet_intents
   SET status = 'review_required'
 WHERE status IN ('failed', 'audit_failed')
   AND tx_hash IS NOT NULL
   AND failure_reason IS DISTINCT FROM 'RepairLane:chain_reverted'
   AND NOT EXISTS (
     SELECT 1
       FROM agent_activity a
      WHERE a.id = wallet_intents.activity_id
        AND a.tx_hash = wallet_intents.tx_hash
        AND a.status = 'definitively_failed'
        AND a.failure_code = 'mined_revert'
   );

ALTER TABLE wallet_intents
  ADD CONSTRAINT wallet_intents_status_check CHECK (status IN (
    'pending',
    'consuming',
    'broadcast_unconfirmed',
    'executed',
    'failed',
    'superseded_unproven',
    'review_required',
    'audit_failed',
    'cancelled',
    'expired'
  ));

ALTER TABLE wallet_intents
  DROP CONSTRAINT IF EXISTS wallet_intents_unconfirmed_evidence;
ALTER TABLE wallet_intents
  ADD CONSTRAINT wallet_intents_unconfirmed_evidence CHECK (
    status NOT IN ('broadcast_unconfirmed', 'superseded_unproven')
    OR (tx_hash IS NOT NULL AND activity_id IS NOT NULL)
  );

ALTER TABLE wallet_intents
  DROP CONSTRAINT IF EXISTS wallet_intents_review_has_hash;
ALTER TABLE wallet_intents
  ADD CONSTRAINT wallet_intents_review_has_hash CHECK (
    status <> 'review_required' OR tx_hash IS NOT NULL
  );

ALTER TABLE wallet_intents
  DROP CONSTRAINT IF EXISTS wallet_intents_failed_hash_evidence;
ALTER TABLE wallet_intents
  ADD CONSTRAINT wallet_intents_failed_hash_evidence CHECK (
    status <> 'failed'
    OR tx_hash IS NULL
    OR activity_id IS NOT NULL
    OR failure_reason IS NOT DISTINCT FROM 'RepairLane:chain_reverted'
  );

-- Rebuild against the final vocabulary so the partial predicate is immutable
-- and immediately useful after the backfill above.
DROP INDEX IF EXISTS idx_wallet_intents_review_queue;
CREATE INDEX idx_wallet_intents_review_queue
  ON wallet_intents (network, repair_checked_at, created_at, intent_id)
  WHERE status = 'review_required' AND tx_hash IS NOT NULL;
