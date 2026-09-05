-- Public consent and transaction identity only. Keys, signatures and signed
-- transaction payloads must never be stored in this table.
CREATE TABLE IF NOT EXISTS lighter_fee_authorization_intents (
  intent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('core', 'rhc')),
  wallet_address TEXT NOT NULL,
  account_index BIGINT NOT NULL CHECK (account_index > 0),
  api_key_index INTEGER NOT NULL CHECK (api_key_index BETWEEN 4 AND 254),
  terms_json JSONB NOT NULL,
  approval_id TEXT REFERENCES approval_queue(id) ON DELETE SET NULL,
  approval_status TEXT NOT NULL DEFAULT 'approval_pending'
    CHECK (approval_status IN ('approval_pending','approved','rejected','expired')),
  execution_state TEXT NOT NULL DEFAULT 'approval_pending'
    CHECK (execution_state IN ('approval_pending','approved','tier_change_staged','tier_ready',
      'signing','submission_staged','submitted','active','ambiguous','failed','rejected','expired')),
  nonce_value TEXT,
  tx_hash TEXT,
  tx_expiry_ms BIGINT,
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ,
  CHECK (approval_status = 'approved' OR execution_state IN ('approval_pending','rejected','expired')),
  CHECK (execution_state NOT IN ('submission_staged','submitted','active') OR tx_hash IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS lighter_fee_authorization_one_live_account
  ON lighter_fee_authorization_intents(environment, account_index)
  WHERE execution_state NOT IN ('active','failed','rejected','expired');
