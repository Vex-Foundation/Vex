-- 072 — `token_launch_intents.superseded_unproven`: the NON-FAILURE terminal
-- status for a launch whose hash is no longer tracked and whose outcome nobody
-- proved.
--
-- WHY IT MUST EXIST. Before this, a launch whose nonce had been consumed by
-- another transaction sat in `broadcast_pending` FOREVER: the identity sweep
-- classified it as `superseded` and deliberately deferred, and no writer could
-- move it out without a decoded receipt that will never arrive. The owner's
-- live case is a launch stuck for over a day, holding its image locked (C2) and
-- occupying the in-flight list with no explanation.
--
-- IT IS NOT A FAILURE. `terminal_failure` asserts the create did not happen; a
-- replacement reusing the nonce may have carried the same calldata and minted
-- the token. So this status says exactly what is known and nothing more, and it
-- deliberately carries NO `failure_reason` — mirroring the semantics
-- `agent_activity.superseded_unproven` already has (migration 068).
--
-- Expand-only in effect: every value the old constraint admitted, the new one
-- still admits. No existing row changes status and no backfill runs.

-- The CHECK is REPLACED, not added to: a constraint cannot be widened in place.
--
-- 062 declared it as an inline COLUMN check, so Postgres assigned its name.
-- Dropping a GUESSED name would be a silent no-op on any database where the
-- name differs, and the old constraint would then still reject every
-- `superseded_unproven` write — the failure mode being a launch that can never
-- leave `broadcast_pending`, discovered in production. So the drop finds the
-- constraint by its DEFINITION, exactly as 068 does for `agent_activity`.
DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'token_launch_intents'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%awaiting_user_form%'
       AND pg_get_constraintdef(con.oid) LIKE '%broadcast_pending%'
       AND pg_get_constraintdef(con.oid) LIKE '%terminal_failure%'
       AND pg_get_constraintdef(con.oid) NOT LIKE '%authorization_id%'
       AND pg_get_constraintdef(con.oid) NOT LIKE '%tx_hash%'
  LOOP
    EXECUTE format('ALTER TABLE token_launch_intents DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_status_check
  CHECK (status IN (
    'awaiting_user_form',
    'authorized',
    'consuming',
    'broadcast_pending',
    'confirmed',
    'terminal_failure',
    'cancelled',
    'expired',
    'superseded_unproven'
  ));

-- THE HASH IS THE WHOLE EVIDENCE. `superseded_unproven` means "this hash is
-- no longer tracked, outcome unproven"; without the hash the status asserts
-- something it cannot point at, and no reader could ever go and check it. The existing
-- `token_launch_intents_broadcast_has_hash` covers only `broadcast_pending` and
-- `confirmed`, so the new status gets its own guard rather than a rewrite of a
-- constraint that is right about what it already says.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'token_launch_intents_superseded_has_hash'
  ) THEN
    ALTER TABLE token_launch_intents
      ADD CONSTRAINT token_launch_intents_superseded_has_hash
      CHECK (status <> 'superseded_unproven' OR tx_hash IS NOT NULL);
  END IF;
END $$;
