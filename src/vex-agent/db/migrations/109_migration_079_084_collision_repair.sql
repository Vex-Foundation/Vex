-- 109_migration_079_084_collision_repair.sql
--
-- Forward repair for the shipped duplicate numeric prefixes 079-084:
--   079_agent_activity_evm_lend / 079_lighter_nonce_state
--   080_lighter_order_previews / 080_swap_prequotes_lend_kinds
--   081_lighter_order_execution_intents / 081_swap_prequotes_borrow_kinds
--   082_lighter_order_submit_lifecycle / 082_pools_fun_launch
--   083_launch_image_onchain_variant / 083_lighter_order_provider_outcomes
--   084_agent_activity_wallet_transfer / 084_lighter_order_pre_submit_revalidation
--
-- Old runners recorded only the numeric prefix, so an installation already
-- beyond 084 cannot prove which sibling ran. Every statement below is
-- idempotent and restores the UNION of both lineages. Where sibling migrations
-- successively restated one CHECK, this repair installs the merged 102 shape
-- directly instead of temporarily narrowing a live database.

-- 079: Lighter nonce state.
CREATE TABLE IF NOT EXISTS lighter_nonce_state (
  environment                  TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index                BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index                INTEGER NOT NULL CHECK (api_key_index >= 0 AND api_key_index <= 255),
  provider_nonce               TEXT NOT NULL CHECK (provider_nonce ~ '^[0-9]+$'),
  public_key                   TEXT NOT NULL CHECK (length(public_key) > 0),
  provider_transaction_time    TEXT CHECK (provider_transaction_time IS NULL OR provider_transaction_time ~ '^[0-9]+$'),
  status                       TEXT NOT NULL DEFAULT 'observed'
    CHECK (status IN ('observed','reserved','submitted','ambiguous')),
  reserved_nonce               TEXT CHECK (reserved_nonce IS NULL OR reserved_nonce ~ '^[0-9]+$'),
  reservation_id               TEXT,
  source                       TEXT NOT NULL DEFAULT 'live_lighter_public_api',
  observed_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, account_index, api_key_index),
  CHECK (
    (status = 'observed' AND reserved_nonce IS NULL AND reservation_id IS NULL)
    OR
    (status IN ('reserved','submitted','ambiguous') AND reserved_nonce IS NOT NULL AND reservation_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_lighter_nonce_state_status
  ON lighter_nonce_state (status, updated_at DESC);

-- 080: Lighter preview gate.
CREATE TABLE IF NOT EXISTS lighter_order_previews (
  preview_id                 TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  match_hash                 TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index              BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index              INTEGER CHECK (api_key_index IS NULL OR (api_key_index >= 0 AND api_key_index <= 255)),
  market_index               INTEGER NOT NULL CHECK (market_index >= 0 AND market_index <= 65535),
  side                       TEXT NOT NULL CHECK (side IN ('buy','sell')),
  base_amount_integer        TEXT NOT NULL CHECK (base_amount_integer ~ '^[1-9][0-9]*$'),
  price_integer              TEXT NOT NULL CHECK (price_integer ~ '^[1-9][0-9]*$'),
  order_type                 TEXT NOT NULL CHECK (order_type IN ('limit','market')),
  time_in_force              TEXT NOT NULL CHECK (time_in_force IN ('good-till-time','immediate-or-cancel','post-only')),
  reduce_only                BOOLEAN NOT NULL,
  trigger_price_integer      TEXT,
  order_expiry_ms            BIGINT NOT NULL,
  client_order_index_policy  TEXT NOT NULL,
  provider_version           TEXT NOT NULL,
  preview_json               JSONB NOT NULL CHECK (jsonb_typeof(preview_json) = 'object'),
  live_source_json           JSONB NOT NULL CHECK (jsonb_typeof(live_source_json) = 'object'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                 TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lighter_order_previews_match
  ON lighter_order_previews (session_id, environment, match_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lighter_order_previews_session
  ON lighter_order_previews (session_id, created_at DESC);

-- 081: Lighter approval-gated execution intent.
CREATE TABLE IF NOT EXISTS lighter_order_execution_intents (
  intent_id                  TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  preview_id                 TEXT NOT NULL REFERENCES lighter_order_previews(preview_id) ON DELETE RESTRICT,
  protocol_execution_id      BIGINT REFERENCES protocol_executions(id) ON DELETE RESTRICT,
  approval_id                TEXT UNIQUE REFERENCES approval_queue(id) ON DELETE SET NULL,
  match_hash                 TEXT NOT NULL CHECK (match_hash ~ '^[0-9a-f]{64}$'),
  environment                TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index              BIGINT NOT NULL CHECK (account_index >= 0),
  api_key_index              INTEGER NOT NULL CHECK (api_key_index >= 4 AND api_key_index <= 254),
  market_index               INTEGER NOT NULL CHECK (market_index >= 0 AND market_index <= 65535),
  side                       TEXT NOT NULL CHECK (side IN ('buy','sell')),
  base_amount_integer        TEXT NOT NULL CHECK (base_amount_integer ~ '^[1-9][0-9]*$'),
  price_integer              TEXT NOT NULL CHECK (price_integer ~ '^[1-9][0-9]*$'),
  order_type                 TEXT NOT NULL CHECK (order_type IN ('limit','market')),
  time_in_force              TEXT NOT NULL CHECK (time_in_force IN ('good-till-time','immediate-or-cancel','post-only')),
  reduce_only                BOOLEAN NOT NULL,
  trigger_price_integer      TEXT,
  order_expiry_ms            BIGINT NOT NULL,
  client_order_index_policy  TEXT NOT NULL,
  provider_version           TEXT NOT NULL,
  credential_ref_json        JSONB NOT NULL CHECK (jsonb_typeof(credential_ref_json) = 'object'),
  approval_status            TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    approval_status IN ('approval_pending','approved','rejected','expired')
  ),
  execution_state            TEXT NOT NULL DEFAULT 'approval_pending' CHECK (
    execution_state IN (
      'previewed','approval_pending','signed','submitted','api_accepted',
      'sequencer_pending','open','partially_filled','filled','canceled',
      'rejected','ambiguous'
    )
  ),
  decision_reason            TEXT,
  decided_at                 TIMESTAMPTZ,
  nonce_reservation_id       TEXT,
  nonce_value                TEXT CHECK (nonce_value IS NULL OR nonce_value ~ '^[0-9]+$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at                 TIMESTAMPTZ NOT NULL,
  CHECK (
    (approval_status = 'approval_pending' AND decided_at IS NULL)
    OR (approval_status <> 'approval_pending' AND decided_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_live_preview
  ON lighter_order_execution_intents (session_id, preview_id)
  WHERE approval_status IN ('approval_pending','approved');
CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_session
  ON lighter_order_execution_intents (session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_approval
  ON lighter_order_execution_intents (approval_id)
  WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_execution
  ON lighter_order_execution_intents (execution_state, updated_at DESC);

-- 082-084: Lighter submit, provider-outcome, and revalidation evidence.
ALTER TABLE lighter_order_execution_intents
  ADD COLUMN IF NOT EXISTS signer_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS submitted_tx_hash TEXT,
  ADD COLUMN IF NOT EXISTS submit_code INTEGER,
  ADD COLUMN IF NOT EXISTS submit_message TEXT,
  ADD COLUMN IF NOT EXISTS predicted_execution_time_ms INTEGER,
  ADD COLUMN IF NOT EXISTS volume_quota_remaining BIGINT,
  ADD COLUMN IF NOT EXISTS ambiguous_reason TEXT,
  ADD COLUMN IF NOT EXISTS signed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS api_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ambiguous_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS client_order_index TEXT,
  ADD COLUMN IF NOT EXISTS provider_order_id TEXT,
  ADD COLUMN IF NOT EXISTS provider_order_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_outcome_source TEXT,
  ADD COLUMN IF NOT EXISTS provider_outcome_json JSONB,
  ADD COLUMN IF NOT EXISTS provider_outcome_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pre_submit_revalidation_json JSONB,
  ADD COLUMN IF NOT EXISTS pre_submit_revalidated_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighter_order_execution_intents_submit_lifecycle_shape') THEN
    ALTER TABLE lighter_order_execution_intents
      ADD CONSTRAINT lighter_order_execution_intents_submit_lifecycle_shape
      CHECK (
        (signer_tx_hash IS NULL OR (length(signer_tx_hash) BETWEEN 1 AND 160 AND signer_tx_hash !~ '[[:space:]{}"]'))
        AND (submitted_tx_hash IS NULL OR (length(submitted_tx_hash) BETWEEN 1 AND 160 AND submitted_tx_hash !~ '[[:space:]{}"]'))
        AND (submit_code IS NULL OR submit_code >= 0)
        AND (submit_message IS NULL OR (length(submit_message) <= 240 AND submit_message !~ '[{}"]'))
        AND (predicted_execution_time_ms IS NULL OR predicted_execution_time_ms >= 0)
        AND (volume_quota_remaining IS NULL OR volume_quota_remaining >= 0)
        AND (ambiguous_reason IS NULL OR (length(ambiguous_reason) <= 240 AND ambiguous_reason !~ '[{}"]'))
        AND (
          (execution_state = 'signed' AND signed_at IS NOT NULL)
          OR (execution_state = 'submitted' AND signed_at IS NOT NULL AND submitted_at IS NOT NULL)
          OR (execution_state = 'api_accepted' AND signed_at IS NOT NULL AND submitted_at IS NOT NULL AND api_accepted_at IS NOT NULL)
          OR (execution_state = 'ambiguous' AND ambiguous_at IS NOT NULL)
          OR execution_state NOT IN ('signed','submitted','api_accepted','ambiguous')
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighter_order_execution_intents_provider_outcome_shape') THEN
    ALTER TABLE lighter_order_execution_intents
      ADD CONSTRAINT lighter_order_execution_intents_provider_outcome_shape
      CHECK (
        (client_order_index IS NULL OR client_order_index ~ '^[0-9]+$')
        AND (provider_order_id IS NULL OR (length(provider_order_id) BETWEEN 1 AND 160 AND provider_order_id !~ '[[:space:]{}"]'))
        AND (provider_order_status IS NULL OR (length(provider_order_status) <= 80 AND provider_order_status !~ '[{}"]'))
        AND (provider_outcome_source IS NULL OR provider_outcome_source IN ('active_order','inactive_order','account_trade','not_found'))
        AND (provider_outcome_json IS NULL OR jsonb_typeof(provider_outcome_json) = 'object')
        AND (
          provider_outcome_checked_at IS NULL
          OR execution_state IN ('sequencer_pending','open','partially_filled','filled','canceled','rejected','ambiguous')
        )
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lighter_order_execution_intents_pre_submit_revalidation_shape') THEN
    ALTER TABLE lighter_order_execution_intents
      ADD CONSTRAINT lighter_order_execution_intents_pre_submit_revalidation_shape
      CHECK (
        (pre_submit_revalidation_json IS NULL) = (pre_submit_revalidated_at IS NULL)
        AND (pre_submit_revalidation_json IS NULL OR jsonb_typeof(pre_submit_revalidation_json) = 'object')
      ) NOT VALID;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_submit_state
  ON lighter_order_execution_intents (execution_state, submitted_at DESC)
  WHERE submitted_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_signer_tx_hash
  ON lighter_order_execution_intents (environment, signer_tx_hash)
  WHERE signer_tx_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lighter_order_execution_intents_client_order
  ON lighter_order_execution_intents (environment, account_index, client_order_index)
  WHERE client_order_index IS NOT NULL;

-- 080-081: final Morpho prequote vocabulary.
ALTER TABLE swap_prequotes DROP CONSTRAINT IF EXISTS swap_prequotes_kind_check;
ALTER TABLE swap_prequotes
  ADD CONSTRAINT swap_prequotes_kind_check
  CHECK (kind IN (
    'swap','bridge','redeem','mint','redeem_py','lp_add','lp_remove',
    'sy_mint','sy_redeem','lp_remove_dual','lp_add_keep_yt','pt_rollover',
    'lp_transfer','lp_to_pt','lend_deposit','lend_withdraw',
    'lend_supply_collateral','lend_withdraw_collateral','lend_borrow','lend_repay'
  ));

-- 082: pools.fun intent fields and final launch state constraints.
ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'trench',
  ADD COLUMN IF NOT EXISTS paired_asset TEXT,
  ADD COLUMN IF NOT EXISTS paired_asset_address TEXT,
  ADD COLUMN IF NOT EXISTS fee_recipient_address TEXT,
  ADD COLUMN IF NOT EXISTS metadata_uri TEXT,
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS predicted_token_address TEXT,
  ADD COLUMN IF NOT EXISTS gateway_address TEXT,
  ADD COLUMN IF NOT EXISTS deployment_fee_wei TEXT;

ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_protocol_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_protocol_check CHECK (protocol IN ('trench','pools_fun'));
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_paired_asset_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_paired_asset_check CHECK (paired_asset IS NULL OR paired_asset IN ('weth','usdg'));
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_pools_has_pair;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_pools_has_pair CHECK (protocol <> 'pools_fun' OR paired_asset IS NOT NULL);
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_status_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_status_check CHECK (status IN (
    'previewed','awaiting_user_form','authorized','consuming','broadcast_pending',
    'confirmed','terminal_failure','cancelled','expired','superseded_unproven'
  ));
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_previewed_is_not_live;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_previewed_is_not_live
  CHECK (status <> 'previewed' OR (authorization_id IS NULL AND tx_hash IS NULL));
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_live_has_authorization;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_live_has_authorization
  CHECK (status IN ('previewed','awaiting_user_form','cancelled','expired') OR (authorization_id IS NOT NULL AND authorization_kind IS NOT NULL));
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_unsigned_exits_have_no_hash;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_unsigned_exits_have_no_hash
  CHECK (status NOT IN ('previewed','cancelled','expired') OR tx_hash IS NULL);

CREATE INDEX IF NOT EXISTS idx_token_launch_intents_previewed
  ON token_launch_intents (session_id, created_at DESC)
  WHERE status = 'previewed';

-- 083: retain the original image and its optional Trench-sized variant.
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_byte_length_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_byte_length_check
  CHECK (byte_length > 0 AND byte_length <= 26214400);
ALTER TABLE launch_images
  ADD COLUMN IF NOT EXISTS onchain_byte_length INTEGER,
  ADD COLUMN IF NOT EXISTS onchain_digest TEXT;
UPDATE launch_images
   SET onchain_byte_length = byte_length,
       onchain_digest = digest
 WHERE onchain_byte_length IS NULL
   AND byte_length <= 20480
   AND digest ~ '^[0-9a-f]{64}$';
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_onchain_paired;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_onchain_paired
  CHECK ((onchain_byte_length IS NULL) = (onchain_digest IS NULL));
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_onchain_byte_length_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_onchain_byte_length_check
  CHECK (onchain_byte_length IS NULL OR (onchain_byte_length > 0 AND onchain_byte_length <= 20480));
ALTER TABLE launch_images DROP CONSTRAINT IF EXISTS launch_images_onchain_digest_check;
ALTER TABLE launch_images
  ADD CONSTRAINT launch_images_onchain_digest_check
  CHECK (onchain_digest IS NULL OR onchain_digest ~ '^[0-9a-f]{64}$');

-- Preserve the full merged vocabulary through 102, including wallet transactions
-- and launchpad claims. Existing main records must survive this older repair.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_family_binding;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_family_binding
  CHECK (
    kind NOT IN ('lend','prediction')
    OR (chain_family = 'solana' AND chain_id = 20011000000)
    OR (kind = 'lend' AND chain_family = 'eip155')
  );

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

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_valid
  CHECK (kind IN ('swap','bridge','lend','prediction','wrap','yield','launch','claim','transfer','transaction'));

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
