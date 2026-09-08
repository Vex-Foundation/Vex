-- 152_lighter_agentscan_activity.sql - the Lighter half of AgentScan reporting.
--
-- Numbered 152 because lane B's renumbered Lighter range ends at 151; this is
-- the next free number under the new (numeric, unique) migration identity.
--
-- FOUR THINGS, and each exists because an existing table cannot hold it.
--
-- 1. `lighter_fills` - a durable ledger, one row per DISTINCT matched fill.
--    The order execution intent stores ONE matching trade as its outcome
--    evidence and is mutable (a later frame replaces it), so it is not a
--    ledger: two fills in one frame, or a fill re-observed by recovery, would
--    be indistinguishable from one another. AgentScan dedupes on
--    (agent_hash, source_row_id), so the reported identity has to be a row id
--    that never moves and never merges. Economics here are IMMUTABLE: an
--    insert conflict never overwrites, and the only UPDATE the repo performs
--    is fee enrichment from NULL (an exact charged amount that was unknown at
--    fill time). Verification outcomes belong to the server, not here.
--
-- 2. `lighter_position_observations` + `lighter_position_market_state` - the
--    account-wide position snapshot. It is NOT an event (it is not activity,
--    it has no transaction and it covers trading Vex did not do), so it
--    cannot ride `agent_activity`. FRESHNESS IS KEYED WITHOUT THE OBSERVATION:
--    the market-state table is unique on (environment, account_index,
--    market_index) and carries the observed_at of the newest observation that
--    covered that market, so a late backfill can never resurrect a position a
--    newer observation closed - INCLUDING a newer EMPTY complete observation,
--    which closes every market it covers.
--
-- 3. `agentscan_outbox` gains a SOURCE DISCRIMINATOR. The outbox was tied to
--    `agent_activity` by a NOT NULL foreign key; a fill has no activity row
--    and must not borrow one, because substituting a ledger id into that
--    foreign key would collide across two id spaces. So the row names which
--    ledger it came from and carries exactly one of the two references, and
--    the delivery machinery (claim-and-stamp, generation fencing, terminal
--    writes) stays single-owner for both.
--
-- 4. `agentscan_server_capabilities` - what the DEPLOYED server advertises,
--    observed durably with its time. The existing process-lifetime capability
--    record learns from ingest refusals, which cannot work for a vocabulary
--    that must never be sent before it is advertised.
--
-- Vocabulary version walks to 4: this database can now STORE the Lighter
-- reporting vocabulary. It says nothing about what any server accepts.

-- ── 1. The fill ledger ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lighter_fills (
  id BIGSERIAL PRIMARY KEY,
  -- Canonical identity, `lighter:<environment>:<accountIndex>:<marketIndex>:<providerTradeId>`.
  -- Enforced independently of the column tuple below so a cross-table id
  -- collision (a ledger id reused as an activity id) cannot pass unnoticed.
  canonical_identity TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index BIGINT NOT NULL CHECK (account_index >= 0),
  market_index INTEGER NOT NULL CHECK (market_index >= 0),
  -- Provider ids are lossless DECIMAL STRINGS: the provider's uint64 trade and
  -- order ids exceed what a JSON number carries exactly.
  provider_trade_id TEXT NOT NULL CHECK (provider_trade_id ~ '^[0-9]+$'),
  provider_order_id TEXT CHECK (provider_order_id ~ '^[0-9]+$'),
  client_order_id TEXT CHECK (client_order_id ~ '^[0-9]+$'),
  -- The Vex order execution intent this fill belongs to: the execution
  -- grouping, stable across every fill of one order.
  execution_intent_id TEXT,
  market_symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  -- Decimal strings throughout. Never floating point, never a bare integer
  -- without its decimals.
  price TEXT NOT NULL CHECK (price ~ '^[0-9]+(\.[0-9]+)?$'),
  base_size TEXT NOT NULL CHECK (base_size ~ '^[0-9]+(\.[0-9]+)?$'),
  quote_notional TEXT NOT NULL CHECK (quote_notional ~ '^[0-9]+(\.[0-9]+)?$'),
  base_asset_id TEXT NOT NULL,
  base_asset_symbol TEXT NOT NULL,
  base_asset_decimals INTEGER NOT NULL CHECK (base_asset_decimals >= 0),
  quote_asset_id TEXT NOT NULL,
  quote_asset_symbol TEXT NOT NULL,
  quote_asset_decimals INTEGER NOT NULL CHECK (quote_asset_decimals >= 0),
  block_height TEXT NOT NULL CHECK (block_height ~ '^[0-9]+$'),
  -- Which side of the book this account was on for THIS fill: the fee tier and
  -- the integrator tick both differ between maker and taker.
  fee_side TEXT NOT NULL CHECK (fee_side IN ('maker','taker')),
  -- AUTHORIZED terms, not evidence of what was charged.
  integrator_fee_tick INTEGER CHECK (integrator_fee_tick >= 0),
  integrator_fee_asset_id TEXT,
  integrator_fee_asset_symbol TEXT,
  integrator_fee_asset_decimals INTEGER CHECK (integrator_fee_asset_decimals >= 0),
  -- Computed on this fill's own notional (or received base for a spot buy),
  -- with the rounding rule recorded. An ESTIMATE, displayed as one.
  integrator_fee_estimated_raw TEXT CHECK (integrator_fee_estimated_raw ~ '^[0-9]+$'),
  integrator_fee_estimate_basis TEXT
    CHECK (integrator_fee_estimate_basis IN ('quote_notional','received_base')),
  -- EXACT provider-reported amount. NULL until proven; never zero as a
  -- placeholder, because a zero is a proven amount.
  integrator_fee_charged_raw TEXT CHECK (integrator_fee_charged_raw ~ '^[0-9]+$'),
  -- The exchange's own tier fee. A rebate is reported negative when the
  -- provider reports one, so the pattern admits a leading '-'.
  exchange_fee_tick INTEGER,
  exchange_fee_charged_raw TEXT CHECK (exchange_fee_charged_raw ~ '^-?[0-9]+$'),
  collector_account_index BIGINT CHECK (collector_account_index >= 0),
  -- Provenance of the authorization only. Never proof that a fee was charged.
  fee_authorization_intent_id TEXT,
  -- When Vex OBSERVED the fill. The provider's own block height above is what
  -- orders it on the venue.
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_lighter_fills_identity
    UNIQUE (environment, account_index, market_index, provider_trade_id),
  CONSTRAINT uniq_lighter_fills_canonical_identity UNIQUE (canonical_identity),
  -- An estimate without its basis is unreadable, and a basis without an
  -- estimate is a claim about nothing.
  CONSTRAINT lighter_fills_estimate_has_basis CHECK (
    (integrator_fee_estimated_raw IS NULL) = (integrator_fee_estimate_basis IS NULL)
  ),
  -- Any integrator fee figure needs the asset it is denominated in.
  CONSTRAINT lighter_fills_fee_asset_complete CHECK (
    (integrator_fee_estimated_raw IS NULL AND integrator_fee_charged_raw IS NULL)
    OR (integrator_fee_asset_id IS NOT NULL
        AND integrator_fee_asset_symbol IS NOT NULL
        AND integrator_fee_asset_decimals IS NOT NULL)
  )
);

COMMENT ON TABLE lighter_fills IS
  'Durable ledger: one row per distinct matched Lighter fill. Economics are immutable; only unknown exact fees are enriched later.';
COMMENT ON COLUMN lighter_fills.canonical_identity IS
  'lighter:<environment>:<accountIndex>:<marketIndex>:<providerTradeId> - the identity AgentScan dedupes on, enforced here too.';
COMMENT ON COLUMN lighter_fills.integrator_fee_charged_raw IS
  'EXACT provider-reported integrator fee. NULL means unproven - never zero as a placeholder.';

CREATE INDEX IF NOT EXISTS idx_lighter_fills_execution
  ON lighter_fills (execution_intent_id);
CREATE INDEX IF NOT EXISTS idx_lighter_fills_scope
  ON lighter_fills (environment, account_index, observed_at DESC);

-- ── 2. Position observations ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lighter_position_observations (
  id BIGSERIAL PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index BIGINT NOT NULL CHECK (account_index >= 0),
  -- The observation's own identity. Deliberately NOT part of the freshness
  -- key: freshness compares observations FOR THE SAME market, and including
  -- the observation id would make every observation its own lineage.
  observation_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source TEXT NOT NULL DEFAULT 'account_endpoint' CHECK (source IN ('account_endpoint')),
  -- 'all' (a complete sweep of every market) or a JSON array of market indexes.
  coverage_markets JSONB NOT NULL,
  -- FALSE when the provider page was truncated or a market read failed. An
  -- incomplete observation updates only the markets it lists and never infers
  -- a closure.
  complete BOOLEAN NOT NULL,
  -- Positions as reported, projected through the payload allowlist. `[]` on a
  -- complete observation means "no open positions", which is a real fact.
  positions JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_lighter_position_observation
    UNIQUE (environment, account_index, observation_id)
);

COMMENT ON TABLE lighter_position_observations IS
  'Account-wide Lighter position observations. Client-reported, never verified; may include activity outside Vex.';

CREATE INDEX IF NOT EXISTS idx_lighter_position_observations_scope
  ON lighter_position_observations (environment, account_index, observed_at DESC);

-- The FRESHNESS MARKER, one row per covered market, keyed WITHOUT the
-- observation id and without observed_at. A closed market keeps its row with
-- `open = FALSE` rather than losing it, so a later backfill carrying an older
-- observed_at cannot resurrect the position: the row is already newer.
CREATE TABLE IF NOT EXISTS lighter_position_market_state (
  environment TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index BIGINT NOT NULL CHECK (account_index >= 0),
  market_index INTEGER NOT NULL CHECK (market_index >= 0),
  -- The observation that last spoke for this market.
  observed_at TIMESTAMPTZ NOT NULL,
  observation_id TEXT NOT NULL,
  -- FALSE = this market was covered by an observation that reported no
  -- position in it (a closure). The row stays as the freshness marker.
  open BOOLEAN NOT NULL,
  position JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, account_index, market_index),
  CONSTRAINT lighter_position_market_state_open_has_position CHECK (
    (open = FALSE AND position IS NULL) OR (open = TRUE AND position IS NOT NULL)
  )
);

COMMENT ON TABLE lighter_position_market_state IS
  'Newest observation per (environment, account, market). Closures keep their row so older backfill cannot resurrect a position.';

-- ── 3. The outbox learns a second source ────────────────────────────────────

ALTER TABLE agentscan_outbox
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'agent_activity';
ALTER TABLE agentscan_outbox
  ADD COLUMN IF NOT EXISTS lighter_fill_id BIGINT REFERENCES lighter_fills(id) ON DELETE CASCADE;

ALTER TABLE agentscan_outbox ALTER COLUMN activity_id DROP NOT NULL;

ALTER TABLE agentscan_outbox DROP CONSTRAINT IF EXISTS agentscan_outbox_source_kind_valid;
ALTER TABLE agentscan_outbox
  ADD CONSTRAINT agentscan_outbox_source_kind_valid
  CHECK (source_kind IN ('agent_activity','lighter_fill'));

-- EXACTLY ONE reference, matching the discriminator. Two id spaces sharing one
-- column is precisely the collision this constraint exists to make impossible.
ALTER TABLE agentscan_outbox DROP CONSTRAINT IF EXISTS agentscan_outbox_source_reference;
ALTER TABLE agentscan_outbox
  ADD CONSTRAINT agentscan_outbox_source_reference
  CHECK (
    (source_kind = 'agent_activity' AND activity_id IS NOT NULL AND lighter_fill_id IS NULL)
    OR (source_kind = 'lighter_fill' AND lighter_fill_id IS NOT NULL AND activity_id IS NULL)
  );

-- The existing UNIQUE (activity_id, status) keeps the activity diff scan
-- idempotent; a fill needs the same guarantee in its own id space.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agentscan_outbox_lighter_fill_pair
  ON agentscan_outbox (lighter_fill_id, status)
  WHERE lighter_fill_id IS NOT NULL;

COMMENT ON COLUMN agentscan_outbox.source_kind IS
  'Which local ledger this row reports: agent_activity, or the Lighter fill ledger.';

-- ── 4. Durable server capability ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agentscan_server_capabilities (
  -- sha256 of the configured base URL. The URL itself is not stored: the
  -- fingerprint is all that is needed to notice that the server changed.
  server_fingerprint TEXT NOT NULL CHECK (server_fingerprint ~ '^[0-9a-f]{64}$'),
  capability TEXT NOT NULL,
  -- TRUE = advertised at `observed_at`; FALSE = positively absent (the server
  -- answered and did not list it, including an old server's 404).
  present BOOLEAN NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The registration this observation belongs to. A re-registration can move
  -- the install to a different agent on a different deployment, so a positive
  -- observation does not survive it.
  registration_generation INTEGER NOT NULL,
  PRIMARY KEY (server_fingerprint, capability)
);

COMMENT ON TABLE agentscan_server_capabilities IS
  'What the deployed AgentScan server advertised, per server fingerprint and registration generation, with the observation time.';

-- ── 5. Reportable vocabulary and the activity vocabulary it needs ───────────

-- The exchange funding legs are ordinary settlement-chain activity: a deposit
-- to the venue and a claimed withdrawal from it, each with a real transaction
-- on Ethereum mainnet or Robinhood Chain. They ride `agent_activity` (and its
-- receipt verification) rather than the fill ledger, so the activity
-- vocabulary has to admit them.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_valid
  CHECK (kind IN ('swap','bridge','lend','prediction','wrap','yield','launch','claim','transfer','transaction','exchange'));

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
    'vex_fee',
    'exchange_deposit', 'exchange_withdrawal'
  ));

-- The kind/role binding is restated in full (the house pattern since 087) with
-- one added arm. Restating is what keeps the binding readable as one rule; the
-- arms above it are byte-identical to lane B's renumbered predecessor.
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
    OR
    (kind = 'exchange' AND event_role IN ('exchange_deposit', 'exchange_withdrawal'))
  );

-- Vocabulary version 4: this database can STORE the Lighter reporting
-- vocabulary. Whether any deployment ACCEPTS it is measured separately, in
-- `agentscan_server_capabilities`.
UPDATE agentscan_reporting_state
   SET vocabulary_version = 4, updated_at = NOW()
 WHERE id = 1 AND vocabulary_version < 4;
