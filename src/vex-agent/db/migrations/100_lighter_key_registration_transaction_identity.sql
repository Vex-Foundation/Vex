-- 100_lighter_key_registration_transaction_identity.sql
-- Durable crash-safe identity and public provider evidence for TxType 8.
--
-- Never store the EIP-191 wallet signature, L2 signature, API private key, or
-- serialized signed transaction body. Those exist only in privileged memory
-- for the sendTx call.

ALTER TABLE lighter_onboarding_intents
  DROP CONSTRAINT IF EXISTS lighter_onboarding_intents_execution_state_check;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_intents_execution_state_check CHECK (
    execution_state IN (
      'prepared',
      'slot_reserved',
      'key_generated_encrypted',
      'approval_pending',
      'approved',
      'key_registration_tx_staged',
      'change_pub_key_submitted',
      'key_verified',
      'nonce_synchronized',
      'active',
      'allowance_verified',
      'approve_submitted',
      'approve_confirmed',
      'deposit_submitted',
      'deposit_confirmed',
      'credited',
      'ambiguous',
      'failed'
    )
  );

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS registration_tx_type SMALLINT,
  ADD COLUMN IF NOT EXISTS registration_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS registration_tx_expired_at BIGINT,
  ADD COLUMN IF NOT EXISTS registration_tx_staged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_submitted_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS registration_submit_code INTEGER,
  ADD COLUMN IF NOT EXISTS registration_predicted_execution_time_ms BIGINT,
  ADD COLUMN IF NOT EXISTS registration_submit_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_ambiguity_reason TEXT,
  ADD COLUMN IF NOT EXISTS registration_key_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_client_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS post_registration_nonce BIGINT,
  ADD COLUMN IF NOT EXISTS registration_nonce_synchronized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS registration_activated_at TIMESTAMPTZ;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_key_registration_tx_identity CHECK (
    capability <> 'key_registration'
    OR execution_state IN (
      'slot_reserved', 'key_generated_encrypted', 'approval_pending', 'approved', 'failed'
    )
    OR (
      registration_tx_type = 8
      AND registration_tx_hash ~ '^[0-9a-f]{80}$'
      AND registration_tx_expired_at > 0
      AND registration_tx_staged_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT lighter_onboarding_key_registration_submit_evidence CHECK (
    (registration_submitted_tx_hash IS NULL
     AND registration_submit_code IS NULL
     AND registration_predicted_execution_time_ms IS NULL
     AND registration_submit_accepted_at IS NULL)
    OR (
      registration_submitted_tx_hash = registration_tx_hash
      AND registration_submit_code = 200
      AND registration_predicted_execution_time_ms >= 0
      AND registration_submit_accepted_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT lighter_onboarding_key_registration_ambiguity CHECK (
    capability <> 'key_registration'
    OR execution_state <> 'ambiguous'
    OR registration_ambiguity_reason ~ '^[a-z0-9_.-]{1,80}$'
  ),
  ADD CONSTRAINT lighter_onboarding_key_registration_verification CHECK (
    capability <> 'key_registration'
    OR execution_state NOT IN ('key_verified', 'nonce_synchronized', 'active')
    OR (
      registration_key_verified_at IS NOT NULL
      AND registration_client_checked_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT lighter_onboarding_key_registration_nonce_sync CHECK (
    capability <> 'key_registration'
    OR execution_state NOT IN ('nonce_synchronized', 'active')
    OR (
      post_registration_nonce = registration_nonce + 1
      AND registration_nonce_synchronized_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT lighter_onboarding_key_registration_activation CHECK (
    capability <> 'key_registration'
    OR execution_state <> 'active'
    OR registration_activated_at IS NOT NULL
  );

COMMENT ON COLUMN lighter_onboarding_intents.registration_tx_hash IS
  'Public Poseidon transaction identity only; signed bodies and signatures are never stored.';
