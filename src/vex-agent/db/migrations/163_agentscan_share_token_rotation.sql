-- Superboard share token rotation. The candidate is the NEW key minted for a rotation
-- AgentScan has not acknowledged yet; it is re-sent verbatim on every retry until
-- acknowledged and is never abandoned by the user (an unknown outcome may already have
-- applied it server-side). rotated_at is stamped by the commit transaction only.
ALTER TABLE agentscan_reporting_state
  ADD COLUMN IF NOT EXISTS share_token_rotation_candidate TEXT,
  ADD COLUMN IF NOT EXISTS share_token_rotated_at TIMESTAMPTZ;
