-- 096_lighter_deposit_transaction_identity.sql — staged sender/nonce and replacement evidence.
--
-- Public transaction identity only. Never store signed payloads or keys.

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS approve_tx_from TEXT,
  ADD COLUMN IF NOT EXISTS approve_tx_nonce BIGINT,
  ADD COLUMN IF NOT EXISTS approve_replacement_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS approve_replacement_reason TEXT,
  ADD COLUMN IF NOT EXISTS approve_replacement_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deposit_tx_from TEXT,
  ADD COLUMN IF NOT EXISTS deposit_tx_nonce BIGINT,
  ADD COLUMN IF NOT EXISTS deposit_replacement_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS deposit_replacement_reason TEXT,
  ADD COLUMN IF NOT EXISTS deposit_replacement_observed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_staged_tx_identity_valid'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_staged_tx_identity_valid
      CHECK (
        (approve_tx_from IS NULL AND approve_tx_nonce IS NULL)
        OR
        (approve_tx_from ~ '^0x[0-9a-fA-F]{40}$'
         AND LOWER(approve_tx_from) = LOWER(wallet_address)
         AND approve_tx_nonce >= 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_deposit_tx_identity_valid'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_deposit_tx_identity_valid
      CHECK (
        (deposit_tx_from IS NULL AND deposit_tx_nonce IS NULL)
        OR
        (deposit_tx_from ~ '^0x[0-9a-fA-F]{40}$'
         AND LOWER(deposit_tx_from) = LOWER(wallet_address)
         AND deposit_tx_nonce >= 0)
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_approve_replacement_complete'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_approve_replacement_complete
      CHECK (
        (approve_replacement_tx_hash IS NULL
         AND approve_replacement_reason IS NULL
         AND approve_replacement_observed_at IS NULL)
        OR
        (approve_replacement_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
         AND approve_replacement_reason = 'repriced'
         AND approve_replacement_observed_at IS NOT NULL
         AND approve_tx_hash IS NOT NULL
         AND approve_tx_from IS NOT NULL
         AND approve_tx_nonce IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'lighter_onboarding_intents_deposit_replacement_complete'
  ) THEN
    ALTER TABLE lighter_onboarding_intents
      ADD CONSTRAINT lighter_onboarding_intents_deposit_replacement_complete
      CHECK (
        (deposit_replacement_tx_hash IS NULL
         AND deposit_replacement_reason IS NULL
         AND deposit_replacement_observed_at IS NULL)
        OR
        (deposit_replacement_tx_hash ~ '^0x[0-9a-fA-F]{64}$'
         AND deposit_replacement_reason = 'repriced'
         AND deposit_replacement_observed_at IS NOT NULL
         AND deposit_tx_hash IS NOT NULL
         AND deposit_tx_from IS NOT NULL
         AND deposit_tx_nonce IS NOT NULL)
      );
  END IF;
END$$;

COMMENT ON COLUMN lighter_onboarding_intents.deposit_replacement_tx_hash IS
  'Mined same-calldata fee-only replacement accepted within the original approval ceiling.';
