-- 093_lighter_deposit_evidence.sql — exact L1-to-L2 deposit proof.
--
-- Public structural evidence only. These columns bind a successful Ethereum
-- receipt and its Deposit event to the exact Lighter transaction and owned
-- account selected by that event. They must never contain private keys,
-- signatures, signed payloads, auth tokens, or decrypted vault state.

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS deposit_l1_block_hash TEXT,
  ADD COLUMN IF NOT EXISTS deposit_l1_block_number BIGINT,
  ADD COLUMN IF NOT EXISTS deposit_event_account_index BIGINT,
  ADD COLUMN IF NOT EXISTS lighter_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS lighter_tx_status BIGINT,
  ADD COLUMN IF NOT EXISTS lighter_block_height BIGINT,
  ADD COLUMN IF NOT EXISTS lighter_executed_at BIGINT,
  ADD COLUMN IF NOT EXISTS lighter_evidence_observed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_deposit_l1_block_hash_valid'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_deposit_l1_block_hash_valid
      CHECK (
        deposit_l1_block_hash IS NULL
        OR deposit_l1_block_hash ~ '^0x[0-9a-fA-F]{64}$'
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_deposit_evidence_values_valid'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_deposit_evidence_values_valid
      CHECK (
        (deposit_l1_block_number IS NULL OR deposit_l1_block_number > 0)
        AND (deposit_event_account_index IS NULL OR deposit_event_account_index >= 0)
        AND (lighter_tx_status IS NULL OR lighter_tx_status >= 0)
        AND (lighter_block_height IS NULL OR lighter_block_height > 0)
        AND (lighter_executed_at IS NULL OR lighter_executed_at > 0)
        AND (lighter_tx_hash IS NULL OR length(lighter_tx_hash) BETWEEN 1 AND 256)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_l1_evidence_complete'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_l1_evidence_complete
      CHECK (
        (deposit_l1_block_hash IS NULL
         AND deposit_l1_block_number IS NULL
         AND deposit_event_account_index IS NULL)
        OR
        (deposit_l1_block_hash IS NOT NULL
         AND deposit_l1_block_number IS NOT NULL
         AND deposit_event_account_index IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_l2_evidence_complete'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_l2_evidence_complete
      CHECK (
        (lighter_tx_hash IS NULL
         AND lighter_tx_status IS NULL
         AND lighter_block_height IS NULL
         AND lighter_executed_at IS NULL
         AND lighter_evidence_observed_at IS NULL)
        OR
        (lighter_tx_hash IS NOT NULL
         AND lighter_tx_status IS NOT NULL
         AND lighter_block_height IS NOT NULL
         AND lighter_executed_at IS NOT NULL
         AND lighter_evidence_observed_at IS NOT NULL
         AND deposit_l1_block_hash IS NOT NULL
         AND deposit_l1_block_number IS NOT NULL
         AND deposit_event_account_index IS NOT NULL)
      );
  END IF;
END$$;

COMMENT ON COLUMN lighter_onboarding_intents.deposit_event_account_index IS
  'Account index emitted by the exact Ethereum gateway Deposit event.';

COMMENT ON COLUMN lighter_onboarding_intents.lighter_tx_hash IS
  'Lighter transaction hash returned for the exact deposit_tx_hash lookup.';
