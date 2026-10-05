-- Position effect depends on provider before-size and sign-change facts.
-- Realized PnL is independent evidence and may remain unknown.
ALTER TABLE lighter_fills DROP CONSTRAINT IF EXISTS lighter_fills_account_facts_whole;
ALTER TABLE lighter_fills ADD CONSTRAINT lighter_fills_account_facts_whole CHECK (
  (position_size_before IS NULL AND position_sign_changed IS NULL
    AND account_pnl IS NULL AND position_effect IS NULL)
  OR (position_size_before IS NOT NULL AND position_sign_changed IS NOT NULL
    AND position_effect IS NOT NULL)
);
