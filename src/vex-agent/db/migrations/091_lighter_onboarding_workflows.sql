-- 091_lighter_onboarding_workflows.sql — one durable onboarding workflow per wallet.
--
-- Public structural state only. This table must never contain private keys,
-- signatures, signed payloads, auth tokens, or decrypted vault material.

CREATE TABLE IF NOT EXISTS lighter_onboarding_workflows (
  environment              TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  wallet_address            TEXT NOT NULL CHECK (
    wallet_address = LOWER(wallet_address)
    AND wallet_address ~ '^0x[0-9a-f]{40}$'
  ),
  workflow_state            TEXT NOT NULL CHECK (
    workflow_state IN (
      'integration_enabled',
      'deposit_approval_pending',
      'deposit_preflight_validated',
      'allowance_verified',
      'approve_staged',
      'approve_confirmed',
      'deposit_staged',
      'deposit_l1_confirmed',
      'deposit_l2_pending',
      'account_resolved',
      'key_generated_encrypted',
      'key_registration_approval_pending',
      'change_pub_key_submitted',
      'key_verified',
      'nonce_synchronized',
      'ready_to_trade',
      'ambiguous',
      'failed'
    )
  ),
  last_stable_state          TEXT CHECK (
    last_stable_state IS NULL OR last_stable_state IN (
      'integration_enabled', 'deposit_approval_pending',
      'deposit_preflight_validated', 'allowance_verified', 'approve_staged',
      'approve_confirmed', 'deposit_staged', 'deposit_l1_confirmed',
      'deposit_l2_pending', 'account_resolved', 'key_generated_encrypted',
      'key_registration_approval_pending', 'change_pub_key_submitted',
      'key_verified', 'nonce_synchronized', 'ready_to_trade', 'failed'
    )
  ),
  active_deposit_intent_id  TEXT REFERENCES lighter_onboarding_intents(intent_id) ON DELETE SET NULL,
  resolved_account_index    BIGINT CHECK (resolved_account_index IS NULL OR resolved_account_index >= 0),
  api_key_index             INTEGER CHECK (api_key_index IS NULL OR api_key_index BETWEEN 4 AND 254),
  public_key_fingerprint    TEXT CHECK (
    public_key_fingerprint IS NULL OR public_key_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  failure_code              TEXT CHECK (
    failure_code IS NULL OR failure_code ~ '^[a-z0-9_.-]{1,80}$'
  ),
  revision                  BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, wallet_address),
  CHECK (
    (workflow_state = 'ambiguous' AND last_stable_state IS NOT NULL)
    OR workflow_state <> 'ambiguous'
  )
);

-- Existing enabled integrations become the initial workflow state on upgrade.
INSERT INTO lighter_onboarding_workflows (
  environment,
  wallet_address,
  workflow_state
)
SELECT environment, wallet_address, 'integration_enabled'
  FROM lighter_integration_settings
 WHERE enabled = TRUE
ON CONFLICT (environment, wallet_address) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_lighter_onboarding_workflows_state
  ON lighter_onboarding_workflows (workflow_state, updated_at DESC);
