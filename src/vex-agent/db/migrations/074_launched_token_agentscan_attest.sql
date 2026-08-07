-- 074 — AgentScan ATTESTATION delivery state for a launched token.
--
-- Every launch already signs and stores `attest_signature` (migration 071)
-- for the trench.express VEX badge. This delivers the SAME proof to a SECOND,
-- independent consumer — the AgentScan attestation registry — over its own
-- keyless POST. A separate delivery state on purpose: the trench lane's
-- `attributed_at` / `attribution_attempted_at` must not gate, or be gated by,
-- this one, or a trench refusal would silently block the AgentScan POST (or
-- vice versa) for a proof both registries can independently accept or refuse.
--
-- Two columns, mirroring 071's pair exactly:
--
--   agentscan_attest_attempted_at — when the last AgentScan attestation POST
--                                   was made. NULL means never tried. Stamped
--                                   on EVERY attempt, successful or not, so a
--                                   permanently refused row moves to the back
--                                   of the queue instead of starving the rest.
--   agentscan_attested_at         — AgentScan CONFIRMED the attestation.
--                                   Terminal: a row with this set leaves the
--                                   sweep's candidate set for good.
--
-- Expand-only: nullable, no default, no backfill. A row with no
-- `attest_signature` is a named gap for this sweep too, for the identical
-- reason 071 documents — nothing after the launch handler holds a signer.

ALTER TABLE launched_tokens
  ADD COLUMN IF NOT EXISTS agentscan_attest_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agentscan_attested_at TIMESTAMPTZ;

COMMENT ON COLUMN launched_tokens.agentscan_attest_attempted_at IS
  'Last AgentScan attestation POST attempt (any outcome). NULL = never tried.';
COMMENT ON COLUMN launched_tokens.agentscan_attested_at IS
  'AgentScan confirmed the attestation. Terminal — the row leaves the sweep''s candidate set for good.';

-- The sweep's candidate set and nothing else: signed, not yet AgentScan-attested.
-- Rows leave it permanently once confirmed, so the index stays small no matter
-- how many tokens accumulate. Independent of 071's identical-shaped index —
-- the two sweeps have disjoint candidate sets.
CREATE INDEX IF NOT EXISTS idx_launched_tokens_pending_agentscan_attest
  ON launched_tokens (agentscan_attest_attempted_at NULLS FIRST)
  WHERE agentscan_attested_at IS NULL AND attest_signature IS NOT NULL;
