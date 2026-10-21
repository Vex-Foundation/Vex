-- VEX INFERENCE AUTO TOP-UP: the user-approved NETWORK FEE CEILING per top-up.
--
-- A standing rule signs deposits without a card each time, so the ETH network
-- fee it may spend must be a bound the user approved, not whatever a fresh
-- estimate says (rule 90: approval-bound fee limits, revalidated before
-- signing). The owner (`vex-app/src/main/vex-cloud/auto-top-up/`) enforces it
-- at admission, at the pre-sign gate and in the final local check, for the
-- poller and for the agent deposit tool alike; a plan above it is refused and
-- the rule reads suspended ("Network fee above your limit").
--
-- max_network_fee_wei  the most one top-up may spend on the network fee, raw
--                      ETH wei (18 decimals), as the fee bound the deposit is
--                      signed under (gas limit times max fee per gas).
--                      NULL only on a rule approved before this column
--                      existed: such a rule has no approved ceiling, so it can
--                      spend nothing until the user edits it (the owner treats
--                      NULL as "every fee is above your limit"). Every rule
--                      written from now on carries one (the repository
--                      requires it).
--
-- WHY A NEW MIGRATION AND NOT AN EDIT OF 178. The runner tracks applied
-- versions, not file contents, so a database that already applied 178 (every
-- development install that ran this branch) would never receive a column
-- added to it. Adding it here reaches those databases and fresh ones alike.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS; the CHECK is added only once.

ALTER TABLE vex_inference_auto_top_up_rules
  ADD COLUMN IF NOT EXISTS max_network_fee_wei NUMERIC(78, 0) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vex_inference_auto_top_up_rules_max_network_fee_positive'
  ) THEN
    ALTER TABLE vex_inference_auto_top_up_rules
      ADD CONSTRAINT vex_inference_auto_top_up_rules_max_network_fee_positive
      CHECK (max_network_fee_wei IS NULL OR max_network_fee_wei > 0);
  END IF;
END
$$;
