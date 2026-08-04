-- THE PENDING FALLBACK LANE'S OWN STATE (R2): a 5 s phase-aware EVM observation
-- loop, a durable claim that survives the transaction that took it, an honest
-- stall clock, and a NON-FAILURE terminal state for a hash we can no longer
-- track.
--
-- WHY EACH COLUMN EXISTS — every one closes a defect that has a concrete
-- reproduction, not a hypothetical:
--
--   evm_claim_lease_until   `FOR UPDATE SKIP LOCKED` releases its row locks when
--                           the CLAIM transaction commits — which is BEFORE the
--                           RPC the claim was taken for. Without durable state a
--                           second driver re-claims a row whose lookup is still
--                           in flight and both spend a call on it. Finite (30 s),
--                           so a process that dies mid-observation self-recovers:
--                           an expired lease is claimable again, the same
--                           recovery shape as `STALE_RUN_TIMEOUT_SECONDS`.
--
--   evm_claim_token         A LEASE ALONE IS NOT OWNERSHIP. A 30 s lease can
--                           expire while its RPC is still in flight; a second
--                           driver then claims the row legitimately, and the
--                           FIRST can come back and either release the second
--                           driver's lease or write a stale observation over a
--                           fresher one. Every post-RPC write and the release
--                           carry `AND evm_claim_token = $token`, so a late
--                           worker's write applies to ZERO rows and is logged as
--                           a lost claim. (Migration 067's `notePendingReason`
--                           already references this column in its `claim`
--                           branch; this migration is what creates it.)
--
--   last_verification_increment_at
--                           THE COUNTER IS NOT THE POLLING CLOCK. At 5 s,
--                           `verification_attempts` would reach the 20-attempt
--                           stall threshold in 100 seconds — against that
--                           threshold's documented ~10-20 MINUTE intent — so a
--                           healthy transaction unknown to the queried node
--                           would render as "verification stalled". Throttling on
--                           `last_checked_at` cannot work: every check refreshes
--                           it, so it is never 30 s old and the counter would
--                           increment ONCE and then never again. Two different
--                           facts need two columns: `last_checked_at` is
--                           FRESHNESS (every check), this one moves only when the
--                           counter actually increments.
--
--                           SO `verification_attempts` NOW COUNTS THROTTLED
--                           INCONCLUSIVE WINDOWS, NOT CHECKS. That is the whole
--                           point of the throttle, and a future reader who
--                           assumes "attempts" means "checks" will mis-tune the
--                           threshold. `STALLED_VERIFICATION_ATTEMPTS = 20` keeps
--                           its ~10-minute meaning at ANY polling rate.
--
--   first_noninclusion_observed_at
--                           The A6 eligibility clock. It measures a CONTINUOUS
--                           non-inclusion RUN, not age: set on the first
--                           `nonce_superseded`/`tx_unknown_to_node` observation
--                           and RESET TO NULL by any conclusive contrary
--                           observation (a receipt, or seeing the tx in the
--                           mempool) — exactly as `verification_attempts`
--                           measures a stall rather than age.
--
--   settlement_decode_version
--                           The decode marker for the amount-correction
--                           fallback, written only AFTER a completed decline. A
--                           bare `last_decode_attempt_at` cannot express
--                           "eligible again because the decoder changed"; storing
--                           the decoder identity+version can. Writing it BEFORE
--                           decoding would be a crash poison (a crash between
--                           claim and completion would exclude the row from that
--                           decoder version forever), which is why it is written
--                           after, and why duplicate deterministic decoding is
--                           tolerated: the fill CAS is compare-before-fill.
--
-- THE NEW STATUS — `superseded_unproven` (owner decision A6). What it asserts,
-- precisely: the row is NO LONGER TRACKED AS IN FLIGHT and its
-- inclusion/replacement outcome is UNPROVEN. It does NOT assert that the hash
-- can no longer be included (only `nonce_superseded` establishes non-inclusion;
-- a `tx_unknown_to_node` hash may still sit in another node's mempool), and it
-- is NOT A FAILURE: no `failure_code` is set, and nothing may render it as one.
-- It exists because the alternative is what production does today — the row
-- stays `pending` forever, which froze every background portfolio snapshot
-- (`isSnapshotAllowed` defers while ANY wallet has a pending row) and kept the
-- repair loops shouting about it every 30 seconds. Terminalizing it releases
-- that guard WITHOUT weakening the guard by one character.
--
-- EXPAND-ONLY. Five nullable columns and ONE widened CHECK member. No column is
-- dropped, no predicate narrowed, no backfill: every existing row keeps its
-- exact status and reads all five columns as NULL, which is the truth about a
-- row whose lane never touched it.
--
-- NUMBERING. 068 follows R1's committed 067.

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS evm_claim_lease_until TIMESTAMPTZ;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS evm_claim_token UUID;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS last_verification_increment_at TIMESTAMPTZ;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS first_noninclusion_observed_at TIMESTAMPTZ;

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS settlement_decode_version TEXT;

-- The CHECK is REPLACED, not added to: a constraint cannot be widened in place.
-- Dropping and re-adding with the extra member is expand-only in effect — every
-- value the old constraint admitted, the new one still admits.
--
-- 044 declared it as an inline COLUMN check, so its name was assigned by
-- Postgres. Dropping a GUESSED name with IF NOT EXISTS would be a silent no-op
-- on any database where the name differs, and the old constraint would then
-- still reject every `superseded_unproven` write — the failure mode being a
-- money row that cannot leave `pending`, discovered in production. So the drop
-- finds the constraint by its DEFINITION instead of by a guessed name.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'agent_activity'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%definitively_failed%'
       AND pg_get_constraintdef(con.oid) NOT LIKE '%failure_code%'
  LOOP
    EXECUTE format('ALTER TABLE agent_activity DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_status_check
  CHECK (status IN ('pending', 'confirmed', 'definitively_failed', 'superseded_unproven'));

-- The claim's own index: the candidate predicate is (status, chain_family) with
-- a due-time ordering, and without this the 5 s lane sequentially scans the whole
-- table on every cycle.
CREATE INDEX IF NOT EXISTS idx_agent_activity_evm_claim
  ON agent_activity (chain_family, COALESCE(last_checked_at, submit_attempted_at), id)
  WHERE status = 'pending' AND tx_hash IS NOT NULL AND submit_attempted_at IS NOT NULL;

COMMENT ON COLUMN agent_activity.evm_claim_lease_until IS
  'The pending-fallback lane''s DURABLE claim lease. FOR UPDATE SKIP LOCKED ends at claim-commit, before the RPC; this is what stops a second driver re-claiming a row whose observation is still in flight. Finite (30 s), so a crashed process self-recovers when it expires.';

COMMENT ON COLUMN agent_activity.evm_claim_token IS
  'Claim GENERATION. Every post-RPC write and the lease release carry AND evm_claim_token = $token, so a worker whose lease expired mid-RPC writes zero rows (logged as sync.evm_claim.lost) instead of overwriting a fresher observation or releasing another driver''s lease.';

COMMENT ON COLUMN agent_activity.last_verification_increment_at IS
  'When verification_attempts last INCREMENTED — deliberately not last_checked_at, which every 5 s check refreshes. Because of this throttle, verification_attempts counts inconclusive WINDOWS (one per 30 s), not checks, so STALLED_VERIFICATION_ATTEMPTS keeps its ~10-minute meaning at any polling rate.';

COMMENT ON COLUMN agent_activity.first_noninclusion_observed_at IS
  'Start of a CONTINUOUS run of non-inclusion observations (nonce_superseded / tx_unknown_to_node). Reset to NULL by any conclusive contrary observation — a receipt, or seeing the transaction in the mempool. Gates the superseded_unproven terminalization; it measures a run, not age.';

COMMENT ON COLUMN agent_activity.settlement_decode_version IS
  'The decoder identity+version that last COMPLETED a decline on this row, written only after the decline completes. A row becomes eligible for the amount fallback again exactly when the decoder version changes; duplicate deterministic decoding is harmless because the fill CAS is compare-before-fill.';
