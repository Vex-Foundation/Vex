-- 085_migration_078_collision_repair.sql - repair the historical 078 collision.
--
-- Databases may have recorded either the former Lighter nonce migration or the
-- AgentScan migration as version 78. The runner advances by numeric version,
-- so these idempotent statements ensure neither half remains skipped after a
-- database has advanced past 079.

CREATE TABLE IF NOT EXISTS lighter_nonce_state (
  environment                  TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index                BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                INTEGER NOT NULL CHECK (api_key_index >= 0 AND api_key_index <= 255),
  provider_nonce               TEXT NOT NULL CHECK (provider_nonce ~ '^[0-9]+$'),
  public_key                   TEXT NOT NULL CHECK (length(public_key) > 0),
  provider_transaction_time    TEXT CHECK (provider_transaction_time IS NULL OR provider_transaction_time ~ '^[0-9]+$'),
  status                       TEXT NOT NULL DEFAULT 'observed'
    CHECK (status IN ('observed','reserved','submitted','ambiguous')),
  reserved_nonce               TEXT CHECK (reserved_nonce IS NULL OR reserved_nonce ~ '^[0-9]+$'),
  reservation_id               TEXT,
  source                       TEXT NOT NULL DEFAULT 'live_lighter_public_api',
  observed_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, account_index, api_key_index),
  CHECK (
    (status = 'observed' AND reserved_nonce IS NULL AND reservation_id IS NULL)
    OR
    (status IN ('reserved','submitted','ambiguous') AND reserved_nonce IS NOT NULL AND reservation_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lighter_nonce_state_status
  ON lighter_nonce_state (status, updated_at DESC);

ALTER TABLE agentscan_outbox DROP CONSTRAINT IF EXISTS agentscan_outbox_status_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agentscan_outbox_status_valid'
  ) THEN
    ALTER TABLE agentscan_outbox
      ADD CONSTRAINT agentscan_outbox_status_valid
      CHECK (status IN ('pending', 'confirmed', 'definitively_failed', 'superseded_unproven'));
  END IF;
END$$;

ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS settled_block_time TIMESTAMPTZ;

COMMENT ON COLUMN agent_activity.settled_block_time IS
  'Chain block time of the settling transaction (never NOW()). NULL when no writer could read it; the AgentScan reporter then sends no confirmation time at all.';
