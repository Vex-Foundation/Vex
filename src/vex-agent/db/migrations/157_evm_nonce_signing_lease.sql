-- Unsigned historical rows are not submitted transactions. Only a live signing
-- lease protects an unsigned nonce; a staged hash keeps the existing policy.
ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS nonce_reservation_until timestamptz,
  ADD COLUMN IF NOT EXISTS nonce_reservation_token uuid;
