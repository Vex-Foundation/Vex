-- 098_lighter_key_registration_metadata.sql — encrypted-key public metadata.
--
-- The private credential remains exclusively in the encrypted local vault.
-- This table stores only its deterministic vault reference, public key,
-- fingerprint, and lifecycle timestamp after the vault write succeeds.

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
  ADD COLUMN IF NOT EXISTS vault_credential_id TEXT,
  ADD COLUMN IF NOT EXISTS public_key TEXT CHECK (
    public_key IS NULL OR public_key ~ '^[0-9a-f]{80}$'
  ),
  ADD COLUMN IF NOT EXISTS public_key_fingerprint TEXT CHECK (
    public_key_fingerprint IS NULL OR public_key_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN IF NOT EXISTS key_generated_at TIMESTAMPTZ;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_key_registration_metadata CHECK (
    capability <> 'key_registration'
    OR execution_state IN ('slot_reserved', 'failed')
    OR (
      vault_credential_id = (
        'lighter/' || environment || '/account-' || resolved_account_index ||
        '/api-key-' || api_key_index
      )
      AND public_key IS NOT NULL
      AND public_key_fingerprint IS NOT NULL
      AND key_generated_at IS NOT NULL
    )
  );
