-- Superboard share token: plaintext stays on this install only. AgentScan
-- stores SHA-256. registered_at is stamped only after POST 200.
ALTER TABLE agentscan_reporting_state
  ADD COLUMN IF NOT EXISTS share_token TEXT,
  ADD COLUMN IF NOT EXISTS share_token_registered_at TIMESTAMPTZ;
