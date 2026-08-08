-- 075 — AgentScan wallet-binding HANDSHAKE state (sprint 3, wire contract v2).
--
-- Registration (v1, `/v1/agents/register`) is replaced client-side by the
-- handshake (v2, `/v2/agents/session/start` + `/v2/agents/session/complete`):
-- the install proves ownership of its wallet addresses by signing a
-- server-issued challenge, and the server answers with a rotated ingest
-- token, the bound agent's display name, and a sync cursor. Four columns
-- capture what the handshake now owns beyond what `registered_at` already
-- tracked:
--
--   agent_name                — the display name AgentScan bound to this
--                                install, returned by session/complete.
--   last_handshake_at         — when the last SUCCESSFUL handshake completed
--                                (distinct from `registered_at`, which the
--                                handshake flow keeps stamping for backward
--                                compatibility with the backfill/drain gate).
--   server_cursor_row_id      — session/complete's `syncState.lastAcceptedRowId`,
--                                nullable (a brand-new agent has no history yet).
--   bound_wallets_fingerprint — sha256 of the sorted `chainFamily:address`
--                                inventory list the last successful handshake
--                                covered, so the lane can detect a wallet
--                                added (or removed) since and re-handshake.
--
-- Expand-only: nullable, no default, no backfill.
--
-- `wallet_conflict` joins `stopped_reason`'s closed set as a DEFENSIVE, not
-- normally-reachable, permanent stop: transfer-on-proof means a valid proof
-- for a wallet already bound elsewhere now transfers the binding instead of
-- refusing with 409 in ordinary operation. The client keeps the handling in
-- case a future server policy reintroduces the refusal.
--
-- The CHECK is REPLACED, not added to: a constraint cannot be widened in
-- place. 073 declared it as an inline COLUMN check, so Postgres assigned its
-- name. Dropping a GUESSED name would be a silent no-op on any database where
-- the name differs, and the old constraint would then still reject every
-- `wallet_conflict` write — so the drop finds the constraint by its
-- DEFINITION, exactly as 072 does for `token_launch_intents`.
--
-- The search predicate matches the three ORIGINAL values only (never the new
-- one), exactly as 072's does — so a second run of this migration finds the
-- same constraint again (its widened definition still contains all three) and
-- repeats an identical drop-and-recreate, rather than finding nothing and
-- failing on a duplicate-name ADD CONSTRAINT.

ALTER TABLE agentscan_reporting_state
  ADD COLUMN IF NOT EXISTS agent_name TEXT,
  ADD COLUMN IF NOT EXISTS last_handshake_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS server_cursor_row_id BIGINT,
  ADD COLUMN IF NOT EXISTS bound_wallets_fingerprint TEXT;

COMMENT ON COLUMN agentscan_reporting_state.agent_name IS
  'Display name AgentScan bound to this install (session/complete response).';
COMMENT ON COLUMN agentscan_reporting_state.last_handshake_at IS
  'When the last successful wallet-binding handshake completed.';
COMMENT ON COLUMN agentscan_reporting_state.server_cursor_row_id IS
  'session/complete syncState.lastAcceptedRowId — null for a brand-new agent.';
COMMENT ON COLUMN agentscan_reporting_state.bound_wallets_fingerprint IS
  'sha256 of the sorted chainFamily:address inventory list the last handshake covered — a change here means re-handshake is due.';

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'agentscan_reporting_state'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%consent_revoked%'
       AND pg_get_constraintdef(con.oid) LIKE '%quarantined%'
       AND pg_get_constraintdef(con.oid) LIKE '%agent_conflict%'
  LOOP
    EXECUTE format('ALTER TABLE agentscan_reporting_state DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;

ALTER TABLE agentscan_reporting_state
  ADD CONSTRAINT agentscan_reporting_state_stopped_reason_check
  CHECK (stopped_reason IN ('consent_revoked', 'quarantined', 'agent_conflict', 'wallet_conflict'));
