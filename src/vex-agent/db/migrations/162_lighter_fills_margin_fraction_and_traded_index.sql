-- The leverage in force BEFORE a Lighter fill, and the access path the local
-- activity feed reads fills by.
--
-- WHY THE COLUMN EXISTS. A fill is the only place the account's leverage at
-- that moment can honestly come from. The account's CURRENT leverage is a
-- different number and belongs to a different question: showing it beside a
-- fill from last week would state something nobody observed. Lighter's own
-- trade record already carries the answer as
-- `taker_initial_margin_fraction_before` / `maker_initial_margin_fraction_before`
-- (measured live 2026-09-10: a 10000-scale INTEGER, 1000 = 10x, the same scale
-- the market endpoint and the wire use, and NOT the percent string the account
-- endpoint reports for a position), and `readLighterAccountFillFacts` has been
-- reading it into `LighterAccountFillFacts.initialMarginFractionBefore` since
-- migration 152 without anywhere to put it. This column is that place.
--
-- WHAT NULL MEANS, and it is one thing: UNKNOWN. The writer stores the value
-- only when the provider reported a whole number inside 1..10000, which is the
-- range the CHECK admits and the range
-- `initialMarginFractionToLeverageDisplay` can read. Anything else - a public
-- trade row that carries no account half at all, a record where the provider
-- omitted the field, a 0, a value above the tick - is stored as NULL rather
-- than clamped into a plausible-looking number, because a clamped leverage is
-- a sentence about the user's money that nobody measured. A NULL is rendered
-- as "leverage unknown", never as a current value passed off as a historical
-- one.
--
-- ROWS WRITTEN BEFORE THIS MIGRATION start NULL and are not bulk-backfilled:
-- reading the venue's trade history per account is a privileged read and a
-- separate decision. They are null UNTIL A LATER MATCHING OBSERVATION CARRIES
-- THE FRACTION - `recordLighterFillActivity` fills the column once, null to
-- known, on a re-observation whose economics agree.
--
-- DELIBERATELY OUTSIDE `lighter_fills_account_facts_whole`. That constraint
-- exists because a position classification resting on half a reading is a
-- guess; this fraction classifies nothing and stands alone. An authenticated
-- observation whose trade record omits the fraction must still be able to
-- establish the account half, and a fill whose account half is already known
-- must still be able to learn the fraction later.

ALTER TABLE lighter_fills
  ADD COLUMN IF NOT EXISTS initial_margin_fraction_before INTEGER;

ALTER TABLE lighter_fills
  DROP CONSTRAINT IF EXISTS lighter_fills_initial_margin_fraction_before_range;
ALTER TABLE lighter_fills
  ADD CONSTRAINT lighter_fills_initial_margin_fraction_before_range
  CHECK (initial_margin_fraction_before IS NULL
         OR initial_margin_fraction_before BETWEEN 1 AND 10000);

COMMENT ON COLUMN lighter_fills.initial_margin_fraction_before IS
  'The account''s initial margin fraction BEFORE this fill, on the provider''s 10000 scale (1000 = 10x): the leverage before the fill, never the account''s effective leverage now. Read from this trade record''s own taker_/maker_initial_margin_fraction_before by the role the account played. NULL means unknown - a public trade row, a record the provider omitted it from, or a reported value outside 1..10000, which the writer stores as unknown rather than as a clamped number. Rows written before migration 162 are null until a later matching observation carries the fraction (no bulk backfill).';

-- THE FEED READS FILLS BY VENUE TIME, not by observation time. The existing
-- `idx_lighter_fills_scope` orders by `observed_at`, which is when Vex saw the
-- fill; a timeline a human reads is ordered by when the VENUE matched it, and
-- the keyset page breaks ties on `id`. Without this index every page of the
-- local activity feed sorts the account's whole fill history.
CREATE INDEX IF NOT EXISTS idx_lighter_fills_traded
  ON lighter_fills (environment, account_index, traded_at DESC, id DESC);
