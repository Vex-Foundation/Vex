-- Restore the merged role vocabulary for installations that already applied
-- the earlier 109 repair. Exact predicates match 087/088/102 on main.
-- No rows, approval records, or execution evidence are rewritten.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_valid
  CHECK (kind IN ('swap','bridge','lend','prediction','wrap','yield','launch','claim','transfer','transaction'));

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_event_role_valid
  CHECK (event_role IN (
    'allowance_reset', 'allowance', 'swap',
    'bridge_deposit', 'bridge_fee', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
    'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
    'predict_buy', 'predict_sell', 'predict_claim', 'predict_close',
    'wrap', 'unwrap',
    'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim',
    'token_launch',
    'trench_fee',
    'swap_fee',
    'pools_fee', 'pools_claim',
    'wallet_transfer',
    'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set',
    'tx_vex_fee',
    'creator_fee_claim', 'holder_reward_claim', 'reward_distribution',
    'launch_cancel',
    'vex_fee'
  ));

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_role_binding
  CHECK (
    (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap', 'trench_fee', 'swap_fee', 'vex_fee'))
    OR
    (kind = 'bridge' AND event_role IN (
      'allowance_reset', 'allowance',
      'bridge_deposit', 'bridge_fee',
      'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
      'vex_fee'
    ))
    OR
    (kind = 'lend' AND event_role IN (
      'allowance_reset', 'allowance',
      'lend_deposit', 'lend_withdraw', 'lend_borrow_operate'
    ))
    OR
    (kind = 'prediction' AND event_role IN (
      'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
    ))
    OR
    (kind = 'wrap' AND event_role IN ('wrap', 'unwrap'))
    OR
    (kind = 'yield' AND event_role IN (
      'allowance_reset', 'allowance',
      'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim'
    ))
    OR
    (kind = 'launch' AND event_role IN (
      'allowance_reset', 'allowance',
      'token_launch', 'launch_cancel', 'trench_fee',
      'pools_fee', 'vex_fee'
    ))
    OR
    (kind = 'claim' AND event_role IN (
      'pools_claim', 'creator_fee_claim', 'holder_reward_claim', 'reward_distribution'
    ))
    OR
    (kind = 'transfer' AND event_role IN ('wallet_transfer'))
    OR
    (kind = 'transaction' AND event_role IN (
      'tx_approve', 'tx_contract_call', 'tx_native_transfer', 'tx_spl_instruction_set',
      'tx_vex_fee'
    ))
  );

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_second_leg_roles_only;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_second_leg_roles_only
  CHECK (
    event_role IN ('yield_py', 'yield_lp')
    OR (
      event_role IN ('pools_claim', 'creator_fee_claim', 'holder_reward_claim')
      AND token_in2_address IS NULL AND token_in2_symbol IS NULL AND token_in2_decimals IS NULL
      AND amount_in2_human IS NULL AND amount_in2_raw IS NULL
      AND executed_amount_in2_human IS NULL AND executed_amount_in2_raw IS NULL
    )
    OR (
      token_in2_address IS NULL AND token_in2_symbol IS NULL AND token_in2_decimals IS NULL
      AND amount_in2_human IS NULL AND amount_in2_raw IS NULL
      AND executed_amount_in2_human IS NULL AND executed_amount_in2_raw IS NULL
      AND token_out2_address IS NULL AND token_out2_symbol IS NULL AND token_out2_decimals IS NULL
      AND amount_out2_human IS NULL AND amount_out2_raw IS NULL
      AND executed_amount_out2_human IS NULL AND executed_amount_out2_raw IS NULL
    )
  );
