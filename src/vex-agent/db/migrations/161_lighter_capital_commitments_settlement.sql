-- When a Lighter capital commitment SETTLED at the provider, so the observation
-- lag can be measured from settlement instead of from admission.
--
-- WHY THIS COLUMN EXISTS. Migration 160 gave the ledger `admitted_at` only, and
-- the self-healing sweep measured its grace window from it. That is the wrong
-- clock: a limit order that rests for an hour and then fills was admitted long
-- ago, so its commitment would have been eligible for retirement the instant it
-- settled - which is exactly the moment another session's ALREADY-READ account
-- snapshot still shows neither the commitment nor the resulting position. The
-- gap is real money: session B reads the account before A fills, A fills and
-- retires, B then admits against a budget that counts A's exposure in NEITHER
-- place.
--
-- `settled_at` is stamped when the intent reaches a TERMINAL provider state, and
-- retirement happens only once `settled_at + observation lag <= now`. The lag is
-- therefore always measured from an OBSERVATION OF SETTLEMENT, never from
-- admission. A commitment whose order is still `open` or `partially_filled`
-- carries no stamp at all and stays live, because the order can still consume
-- the capital it reserved.
--
-- Immediate retirement is unchanged and still belongs to PROVEN NON-SUBMISSION
-- (an approval rejected or expired before signing, a refusal while
-- `send_attempt_started_at IS NULL`): nothing on the account can be covering
-- those, so no lag is owed.
--
-- Expand-only and backwards compatible: existing rows get NULL, which the sweep
-- reads as "settlement not observed yet" and stamps on its next pass.

ALTER TABLE lighter_capital_commitments
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- A settlement can never predate the admission that created the commitment; a
-- row that claimed otherwise would shorten its own lag.
ALTER TABLE lighter_capital_commitments
  DROP CONSTRAINT IF EXISTS lighter_capital_commitments_settled_after_admitted;
ALTER TABLE lighter_capital_commitments
  ADD CONSTRAINT lighter_capital_commitments_settled_after_admitted
  CHECK (settled_at IS NULL OR settled_at >= admitted_at);

-- The sweep's second phase asks for live rows of one account whose settlement
-- stamp has aged past the lag; the live partial index from 160 already narrows
-- the account, and this one narrows it to the settled ones.
CREATE INDEX IF NOT EXISTS lighter_capital_commitments_settled_live
  ON lighter_capital_commitments(environment, account_index, settled_at)
  WHERE state = 'live' AND settled_at IS NOT NULL;
