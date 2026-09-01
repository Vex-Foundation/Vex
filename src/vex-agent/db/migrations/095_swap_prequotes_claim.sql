-- 095_swap_prequotes_claim.sql - a quote authorizes exactly one execute.
--
-- RUNS AFTER 094.
--
-- Incident 2026-08-27: a KyberSwap quote showed 313,879.7 CCF at 500 bps, the
-- execute RE-QUOTED at broadcast time and derived its price floor from the
-- fresh route, and the confirmed fill was 1,190.145 CCF - 263x worse than the
-- number a human approved, with no revert, because the floor was rederived from
-- the very route that had moved. The fix binds the fill to the APPROVED quote;
-- this migration gives the prequote row the lifecycle that binding needs.
--
-- Three facts are added, and nothing existing changes meaning:
--
--   eligibility_kind  The closed quote-eligibility union
--                     (`protocols/quote-authority/eligibility.ts`). Only
--                     'executable' may be claimed. The other four members are
--                     REASONS a quote did not authorize anything, and they are
--                     recorded rather than skipped: an unpriceable or
--                     provider-shape-invalid Q2 must SUPERSEDE an older priced
--                     Q1 for the same identity, which it can only do by
--                     existing as a row.
--                     Existing rows default to 'executable'. That is safe by
--                     construction: a claim additionally requires a stored
--                     route snapshot, and no pre-095 row carries one, so an old
--                     row is refused by the snapshot check, not by this column.
--
--   claimed_at        Set once, by the atomic claim. NULL means unclaimed.
--   claimed_by        The execute correlation that won the claim.
--
-- THE CLAIM (repo `claimForExecute`) is a single
-- `UPDATE ... WHERE <claimable> RETURNING`. Postgres serializes concurrent
-- updates of one row, so exactly one caller observes a returned row and every
-- other caller matches zero rows and receives a typed refusal. The claimable
-- predicate is: unclaimed AND unexpired AND eligibility_kind = 'executable' AND
-- NO NEWER ROW EXISTS for the same (session_id, match_hash, kind). The last
-- clause is what makes a later quote authoritative: Q2 supersedes Q1 even when
-- Q1 is unexpired and unclaimed, whatever Q2's own eligibility says.
--
-- Ordering within an identity is (created_at, prequote_id) so two rows written
-- inside the same clock tick still have exactly one newest row.
--
-- Forward-only; idempotent. No backfill: the columns' defaults are the
-- pre-existing behaviour of every row that already exists.

ALTER TABLE swap_prequotes
  ADD COLUMN IF NOT EXISTS eligibility_kind TEXT NOT NULL DEFAULT 'executable',
  ADD COLUMN IF NOT EXISTS claimed_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_by       TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'swap_prequotes_eligibility_kind_check'
  ) THEN
    ALTER TABLE swap_prequotes
      ADD CONSTRAINT swap_prequotes_eligibility_kind_check
      CHECK (eligibility_kind IN (
        'executable',
        'unpriceable_output',
        'excessive_impact',
        'oversize_snapshot',
        'provider_usd_invalid'
      ));
  END IF;
END $$;

-- A claim is only ever set once, and it always carries its owner.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'swap_prequotes_claim_pair_check'
  ) THEN
    ALTER TABLE swap_prequotes
      ADD CONSTRAINT swap_prequotes_claim_pair_check
      CHECK ((claimed_at IS NULL) = (claimed_by IS NULL));
  END IF;
END $$;

-- The claim's supersession probe: "does a newer row exist for this identity".
-- `idx_swap_prequotes_match` already covers (session_id, match_hash,
-- created_at DESC); this one adds `kind` so the probe is index-only for the
-- exact predicate the claim uses.
CREATE INDEX IF NOT EXISTS idx_swap_prequotes_identity_recency
  ON swap_prequotes (session_id, match_hash, kind, created_at DESC, prequote_id DESC);
