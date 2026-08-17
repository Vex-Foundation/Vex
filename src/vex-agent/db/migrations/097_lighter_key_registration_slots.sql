-- 097_lighter_key_registration_slots.sql — Phase 3 API-key slot reservation.
--
-- This extends the capability-tagged onboarding intent table with public,
-- structural slot evidence only. It must never contain API private keys,
-- wallet signatures, auth tokens, or signed transaction payloads.

ALTER TABLE lighter_onboarding_intents
  DROP CONSTRAINT IF EXISTS lighter_onboarding_intents_execution_state_check;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_intents_execution_state_check CHECK (
    execution_state IN (
      'prepared',
      'slot_reserved',
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
  ADD COLUMN IF NOT EXISTS api_key_index INTEGER CHECK (
    api_key_index IS NULL OR api_key_index BETWEEN 4 AND 254
  ),
  ADD COLUMN IF NOT EXISTS slot_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS slot_observation_hash TEXT CHECK (
    slot_observation_hash IS NULL OR slot_observation_hash ~ '^[0-9a-f]{64}$'
  );

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_key_registration_slot_fields CHECK (
    capability <> 'key_registration'
    OR (
      resolved_account_index IS NOT NULL
      AND api_key_index IS NOT NULL
      AND slot_observed_at IS NOT NULL
      AND slot_observation_hash IS NOT NULL
    )
  );

-- One unfinished registration per account. Rotation must be an explicit later
-- lifecycle that first resolves the current registration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lighter_key_registration_live_account
  ON lighter_onboarding_intents (environment, resolved_account_index)
  WHERE capability = 'key_registration'
    AND execution_state NOT IN ('failed');

-- A non-failed slot is never silently recycled, including after registration.
CREATE UNIQUE INDEX IF NOT EXISTS uq_lighter_key_registration_held_slot
  ON lighter_onboarding_intents (environment, resolved_account_index, api_key_index)
  WHERE capability = 'key_registration'
    AND execution_state NOT IN ('failed');
