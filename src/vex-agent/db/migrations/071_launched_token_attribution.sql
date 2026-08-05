-- 071 — creator ATTRIBUTION state for a launched token (the VEX badge).
--
-- Three columns, one per fact, because collapsing them loses the ability to
-- retry safely:
--
--   attest_signature        — the creator wallet's `personal_sign` over
--                             `VEX-attest:<chainId>:<token>`. Signable ONLY at
--                             launch time, while the launch's signing clients
--                             are still open: the address does not exist before
--                             the receipt, and nothing after the handler holds a
--                             signer (the identity-repair sweep deliberately has
--                             none). A row without it can never be attributed by
--                             the sweep, which is why the sweep counts and names
--                             that gap instead of silently skipping it.
--   attribution_attempted_at— when the last POST was made. NULL means never
--                             tried. It is stamped on EVERY attempt, successful
--                             or not, so a permanently refused row moves to the
--                             back of the queue instead of being re-served on
--                             every pass.
--   attributed_at           — the launchpad CONFIRMED the badge. Terminal: a row
--                             with this set leaves the sweep's candidate set for
--                             good.
--
-- Expand-only: nullable, no default, no backfill. Every launch that happened
-- before this migration reads as "never attempted, no signature" — the honest
-- state, and one the sweep reports as the named gap rather than retrying
-- forever with nothing to send.

ALTER TABLE launched_tokens
  ADD COLUMN IF NOT EXISTS attest_signature TEXT,
  ADD COLUMN IF NOT EXISTS attribution_attempted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS attributed_at TIMESTAMPTZ;

-- The sweep's candidate set and nothing else: signed, not yet attributed. Rows
-- leave it permanently once the badge lands, so the index stays small no matter
-- how many tokens accumulate.
CREATE INDEX IF NOT EXISTS idx_launched_tokens_pending_attribution
  ON launched_tokens (attribution_attempted_at NULLS FIRST)
  WHERE attributed_at IS NULL AND attest_signature IS NOT NULL;
