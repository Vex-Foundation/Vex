-- 099_lighter_key_registration_approval.sql — approval-bound public nonce.
--
-- The L2ChangePubKey EIP-191 message includes the slot's next nonce. Persist
-- that public value before approval so signing cannot silently change the
-- human-readable message. Signatures and signed payloads are never stored.

ALTER TABLE lighter_onboarding_intents
  ADD COLUMN IF NOT EXISTS registration_nonce BIGINT CHECK (
    registration_nonce IS NULL
    OR registration_nonce BETWEEN 0 AND 281474976710655
  ),
  ADD COLUMN IF NOT EXISTS registration_nonce_observed_at TIMESTAMPTZ;

ALTER TABLE lighter_onboarding_intents
  ADD CONSTRAINT lighter_onboarding_key_registration_approval_fields CHECK (
    capability <> 'key_registration'
    OR execution_state IN ('slot_reserved', 'key_generated_encrypted', 'failed')
    OR (
      registration_nonce IS NOT NULL
      AND registration_nonce_observed_at IS NOT NULL
    )
  );
