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
-- 2. `lighter_position_observations` + `lighter_position_market_state` +
--    `lighter_position_sweep_state` - the account-wide position snapshot. It
--    is NOT an event (it is not activity, it has no transaction and it covers
--    trading Vex did not do), so it cannot ride `agent_activity`.
--
--    FRESHNESS IS KEYED WITHOUT THE OBSERVATION, AT TWO LEVELS. The
--    market-state table is unique on (environment, account_index,
--    market_index) and carries the observed_at of the newest observation that
--    covered that market. The sweep-state table carries the SCOPE watermark:
--    the observed_at of the newest COMPLETE observation whose coverage was
--    "all". A complete "all" observation speaks for every market including the
--    ones it does not list, so a market it never mentioned has no row of its
--    own to defend it and the scope watermark is that market's marker. Without
--    the scope watermark an empty complete observation at 12:00 writes no
--    market rows at all, and an 11:00 backfill listing an open position then
--    resurrects a position the 12:00 reading proved closed.
--
--    The same table carries the ATTEMPT marker (`last_attempt_at`,
--    `last_attempt_result`). Ordering the sweep by the last SUCCESSFUL
--    observation starves: five scopes that always fail (no credential, a
--    provider error) keep a NULL last-observation forever and occupy every
--    bounded sweep, so a sixth healthy account is never reached. Ordering by
--    the last ATTEMPT is what makes the queue fair, and it is the same rule a
--    bounded work queue uses when it moves a task off the queue before running
--    it rather than after it succeeds.
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
  -- LIGHTER'S OWN CLASSIFICATION of the record. A liquidation and a
  -- deleverage are fills the user did not ask for, and reporting them as
  -- ordinary trading would misdescribe what happened to the account.
  -- No DEFAULT anywhere in this block: the table is created here and the row
  -- writer always supplies all three. A default would let a writer that forgot
  -- one record 'trade' at NOW() for zero dollars, which reads as a fact.
  trade_type TEXT NOT NULL
    CHECK (trade_type IN ('trade','liquidation','deleverage','market-settlement')),
  -- When the VENUE matched the fill (`trade.timestamp`). MEASURED against the
  -- live public endpoint on 2026-09-08: epoch MILLISECONDS (1788858716527
  -- beside a wall clock of 1788858717535), with `transaction_time` beside it
  -- in MICROSECONDS. This is the campaign API's "time"; `observed_at` below is
  -- when Vex saw the fill and is a different fact.
  traded_at TIMESTAMPTZ NOT NULL,
  -- `trade.transaction_time`, epoch microseconds, lossless as a decimal string.
  transaction_time_us TEXT CHECK (transaction_time_us ~ '^[0-9]+$'),
  -- LIGHTER'S OWN USD notional (`usd_amount`), which is what the campaign sums
  -- as volume. `quote_notional` above is OUR exact product of size and price in
  -- the quote asset: the two agree on a USD-quoted market and would not on any
  -- other, and only this one is the provider's word.
  usd_amount TEXT NOT NULL CHECK (usd_amount ~ '^[0-9]+(\.[0-9]+)?$'),
  -- ── The account's own half of the trade record ────────────────────────────
  --
  -- NULL together and non-null together. A public `recentTrades` row does not
  -- carry them (measured 2026-09-08: it carries the position sizes but not the
  -- realized PnL), so a fill first seen publicly holds them null until an
  -- authenticated observation supplies them - once, through the merge rule in
  -- `agentscan-activity.ts`, which fills nulls and never revises a value.
  --
  -- Signed decimal strings: a short position before the fill is negative, and
  -- a realized loss is negative.
  position_size_before TEXT CHECK (position_size_before ~ '^-?[0-9]+(\.[0-9]+)?$'),
  position_sign_changed BOOLEAN,
  entry_quote_before TEXT CHECK (entry_quote_before ~ '^-?[0-9]+(\.[0-9]+)?$'),
  -- Lighter's realized PnL for THIS account on THIS fill, from the ask or bid
  -- side by the side the account traded. Never computed here from entry and
  -- exit: an arithmetic PnL of our own would disagree with the venue's the
  -- moment funding or fees enter.
  account_pnl TEXT CHECK (account_pnl ~ '^-?[0-9]+(\.[0-9]+)?$'),
  -- What the fill did to the account's position, classified from the three
  -- columns above. 'unknown' is the narrow case where they are present and
  -- contradict each other (a fill larger than the position it opposed, with no
  -- sign change reported); NULL is the wider one, "not known yet".
  position_effect TEXT
    CHECK (position_effect IN ('open','increase','reduce','close','flip','unknown')),
  -- Which side of the book this account was on for THIS fill: the fee tier and
  -- the integrator tick both differ between maker and taker.
  fee_side TEXT NOT NULL CHECK (fee_side IN ('maker','taker')),
  -- AUTHORIZED terms, not evidence of what was charged: what the integrator
  -- approval PERMITS for this side of the book.
  integrator_fee_tick_authorized INTEGER CHECK (integrator_fee_tick_authorized >= 0),
  -- OBSERVED: the integrator tick the provider stamped on THIS trade record
  -- (`integrator_maker_fee` / `integrator_taker_fee`), null when the record
  -- carries none. An authorized term is not evidence that it was applied, so
  -- the two never share a column.
  integrator_fee_tick_observed INTEGER CHECK (integrator_fee_tick_observed >= 0),
  integrator_fee_asset_id TEXT,
  integrator_fee_asset_symbol TEXT,
  integrator_fee_asset_decimals INTEGER CHECK (integrator_fee_asset_decimals >= 0),
  -- Computed on this fill's own notional (or received base for a spot buy),
  -- with the rounding rule recorded. An ESTIMATE, displayed as one.
  integrator_fee_estimated_raw TEXT CHECK (integrator_fee_estimated_raw ~ '^[0-9]+$'),
  integrator_fee_estimate_basis TEXT
    CHECK (integrator_fee_estimate_basis IN ('quote_notional','received_base')),
  -- WHICH TICK the estimate was computed from. The observed tick when the
  -- trade record carried one, the authorized term otherwise - and a reader is
  -- never left to guess which, because the two answer different questions and
  -- an estimate on the authorized basis is a weaker claim.
  integrator_fee_estimate_tick_source TEXT
    CHECK (integrator_fee_estimate_tick_source IN ('observed','authorized')),
  -- EXACT provider-reported amount. NULL until proven; never zero as a
  -- placeholder, because a zero is a proven amount.
  integrator_fee_charged_raw TEXT CHECK (integrator_fee_charged_raw ~ '^[0-9]+$'),
  -- The exchange's own tier fee, as OBSERVED on the trade record
  -- (`maker_fee` / `taker_fee` are RATE TICKS in millionths of notional, the
  -- same unit as the integrator ticks - measured live 2026-09-08: 350 on RHC,
  -- 100 and 28 on Core beside notionals under one dollar - not amounts).
  -- A rebate is reported negative when the provider reports one, so the
  -- charged amount below admits a leading '-'.
  exchange_fee_tick_observed INTEGER,
  exchange_fee_charged_raw TEXT CHECK (exchange_fee_charged_raw ~ '^-?[0-9]+$'),
  -- FEE ESTIMATES IN USD, computed on Lighter's own `usd_amount` and its rate
  -- tick - never on an assumed stablecoin parity, and never on a quote-asset
  -- amount relabelled as dollars. NULL for the integrator fee on a spot BUY,
  -- which is charged in the received base and keeps that denomination.
  -- ESTIMATES, and the campaign displays them as such.
  integrator_fee_estimated_usd TEXT CHECK (integrator_fee_estimated_usd ~ '^[0-9]+(\.[0-9]+)?$'),
  exchange_fee_estimated_usd TEXT CHECK (exchange_fee_estimated_usd ~ '^[0-9]+(\.[0-9]+)?$'),
  collector_account_index BIGINT CHECK (collector_account_index >= 0),
  -- Provenance of the authorization only. Never proof that a fee was charged.
  fee_authorization_intent_id TEXT,
  -- ENRICHMENT REVISION. 0 at insert and incremented ONLY by the enrichment
  -- UPDATE, which is the only write this table admits after the insert. It is
  -- the monotonic token the enrichment outbox row is keyed on, so a fee learned
  -- after the fill was already delivered reaches the server exactly once and a
  -- repeat of the same enrichment - which updates nothing, because the
  -- `IS NULL` guard refuses to revise a proven amount - produces no second row.
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
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
    AND (integrator_fee_estimated_raw IS NULL) = (integrator_fee_estimate_tick_source IS NULL)
  ),
  -- THE ACCOUNT'S OWN HALF ARRIVES WHOLE OR NOT AT ALL. Three columns come
  -- from one authenticated observation; two of three would be a classification
  -- resting on a field nobody read.
  CONSTRAINT lighter_fills_account_facts_whole CHECK (
    (position_size_before IS NULL AND position_sign_changed IS NULL
     AND account_pnl IS NULL AND position_effect IS NULL)
    OR (position_size_before IS NOT NULL AND position_sign_changed IS NOT NULL
        AND account_pnl IS NOT NULL AND position_effect IS NOT NULL)
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
COMMENT ON COLUMN lighter_fills.integrator_fee_tick_authorized IS
  'The tick the integrator approval PERMITS for this side. An authorized term, never evidence of what was applied.';
COMMENT ON COLUMN lighter_fills.integrator_fee_tick_observed IS
  'The integrator tick the provider stamped on this trade record. NULL when the record carried none.';
COMMENT ON COLUMN lighter_fills.exchange_fee_tick_observed IS
  'The exchange tier tick observed on this trade record, in millionths of notional.';
COMMENT ON COLUMN lighter_fills.revision IS
  'Incremented by the enrichment writes: an exact charged fee, or the account-relative knowledge a later authenticated observation supplies. The monotonic token the enrichment outbox row is keyed on.';
COMMENT ON COLUMN lighter_fills.traded_at IS
  'When the VENUE matched the fill (trade.timestamp, measured epoch milliseconds 2026-09-08). Not observed_at.';
COMMENT ON COLUMN lighter_fills.usd_amount IS
  'Lighter''s own usd_amount for the fill: the campaign''s volume. quote_notional is our own size x price in the quote asset.';
COMMENT ON COLUMN lighter_fills.account_pnl IS
  'Lighter''s realized PnL for this account on this fill, as reported. Never computed from entry and exit.';
COMMENT ON COLUMN lighter_fills.position_effect IS
  'open | increase | reduce | close | flip, from Lighter''s own fields. NULL until the account-relative fields exist; established once.';
COMMENT ON COLUMN lighter_fills.execution_intent_id IS
  'The Vex order execution intent. NULL means the fill is HELD: observed before its intent was known, never reported until attachLighterFillToIntent proves the binding.';

-- HELD ROWS ARE THE ONES WITHOUT AN INTENT, and the outbox diff scan skips
-- them by that null. A partial index keeps that scan from walking rows it will
-- never enqueue.
CREATE INDEX IF NOT EXISTS idx_lighter_fills_held
  ON lighter_fills (environment, account_index, market_index)
  WHERE execution_intent_id IS NULL;

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
  -- DELIVERY TO AGENTSCAN. The wire path sends the NEWEST unsent observation
  -- per scope and settles every older unsent one of that scope in the same
  -- transaction. Two columns rather than one on purpose: marking a superseded
  -- observation 'sent' would be a false statement, and leaving it unsent
  -- would put it at the head of every later batch to be ignored as stale.
  sent_at TIMESTAMPTZ,
  send_disposition TEXT CHECK (send_disposition IN ('sent','superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_lighter_position_observation
    UNIQUE (environment, account_index, observation_id),
  CONSTRAINT lighter_position_observations_send_settled
    CHECK ((sent_at IS NULL) = (send_disposition IS NULL))
);

COMMENT ON TABLE lighter_position_observations IS
  'Account-wide Lighter position observations. Client-reported, never verified; may include activity outside Vex.';
COMMENT ON COLUMN lighter_position_observations.send_disposition IS
  'sent = this install delivered it and the server took it; superseded = a newer reading of the same account was delivered instead and this one never will be. Never NULL once sent_at is set.';

CREATE INDEX IF NOT EXISTS idx_lighter_position_observations_scope
  ON lighter_position_observations (environment, account_index, observed_at DESC);
-- The unsent reader walks each scope newest-first; the partial index keeps it
-- off the settled rows entirely.
CREATE INDEX IF NOT EXISTS idx_lighter_position_observations_unsent
  ON lighter_position_observations (environment, account_index, observed_at DESC)
  WHERE sent_at IS NULL;

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

-- THE SCOPE WATERMARK AND THE ATTEMPT MARKER, one row per observed scope.
--
-- The watermark is what a market with NO row of its own is defended by. A
-- complete observation whose coverage is "all" speaks for every market on the
-- account, including the ones it does not list, so after it lands nothing
-- older than it may move any market in that scope - and an EMPTY complete
-- observation, which writes no market row anywhere, is exactly the case where
-- the market table alone has nothing to refuse the next late backfill with.
--
-- A complete observation whose coverage is a LIST does not advance the
-- watermark: it never spoke for the markets outside its list, and letting it
-- claim the scope would silence readings it has no authority over.
--
-- The attempt marker is the fairness token. It moves on every attempt,
-- including one that found no credential and one the provider refused, so a
-- permanently failing scope cannot hold a slot in the next bounded sweep.
CREATE TABLE IF NOT EXISTS lighter_position_sweep_state (
  environment TEXT NOT NULL CHECK (environment IN ('core','rhc')),
  account_index BIGINT NOT NULL CHECK (account_index >= 0),
  -- observed_at of the newest COMPLETE, coverage-"all" observation stored for
  -- this scope. NULL when no such observation has ever landed.
  complete_watermark_at TIMESTAMPTZ,
  complete_watermark_observation_id TEXT,
  -- When this scope was last ATTEMPTED, whatever the attempt produced.
  last_attempt_at TIMESTAMPTZ,
  -- 'attempted' is written BEFORE the provider read and overwritten by the
  -- settled reason after it; a row still reading 'attempted' is a sweep that
  -- died mid-scope, and the scope has already moved to the tail of the queue
  -- rather than blocking every later sweep on the same failure.
  last_attempt_result TEXT
    CHECK (last_attempt_result IN ('attempted','no_credential','provider_unavailable','observed')),
  -- When this scope last produced an observation. Reporting only; the ORDER is
  -- the attempt, never this.
  last_observed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (environment, account_index),
  CONSTRAINT lighter_position_sweep_state_watermark_complete CHECK (
    (complete_watermark_at IS NULL) = (complete_watermark_observation_id IS NULL)
  ),
  CONSTRAINT lighter_position_sweep_state_attempt_complete CHECK (
    (last_attempt_at IS NULL) = (last_attempt_result IS NULL)
  )
);

COMMENT ON TABLE lighter_position_sweep_state IS
  'Per-scope snapshot state: the complete-coverage freshness watermark, and the last attempt with its result so a failing scope cannot starve a healthy one.';
COMMENT ON COLUMN lighter_position_sweep_state.complete_watermark_at IS
  'observed_at of the newest COMPLETE coverage-all observation. Any older observation is refused for every market in the scope.';
COMMENT ON COLUMN lighter_position_sweep_state.last_attempt_at IS
  'The sweep ORDERS by this, never by the last success: ordering by success starves scopes that always fail.';

-- ── 3. The outbox learns a second source ────────────────────────────────────

ALTER TABLE agentscan_outbox
  ADD COLUMN IF NOT EXISTS source_kind TEXT NOT NULL DEFAULT 'agent_activity';
ALTER TABLE agentscan_outbox
  ADD COLUMN IF NOT EXISTS lighter_fill_id BIGINT REFERENCES lighter_fills(id) ON DELETE CASCADE;
-- Which `lighter_fills.revision` an ENRICHMENT row carries. NULL on every other
-- kind of row, and the reason the enrichment is deliverable at all: the fill's
-- own outbox row is terminal once sent, so an exact fee proven afterwards has
-- no row left to ride and would otherwise never reach the server.
ALTER TABLE agentscan_outbox
  ADD COLUMN IF NOT EXISTS enrichment_revision INTEGER CHECK (enrichment_revision > 0);

ALTER TABLE agentscan_outbox ALTER COLUMN activity_id DROP NOT NULL;

ALTER TABLE agentscan_outbox DROP CONSTRAINT IF EXISTS agentscan_outbox_source_kind_valid;
ALTER TABLE agentscan_outbox
  ADD CONSTRAINT agentscan_outbox_source_kind_valid
  CHECK (source_kind IN ('agent_activity','lighter_fill','lighter_fill_enrichment'));

-- EXACTLY ONE reference, matching the discriminator. Two id spaces sharing one
-- column is precisely the collision this constraint exists to make impossible.
ALTER TABLE agentscan_outbox DROP CONSTRAINT IF EXISTS agentscan_outbox_source_reference;
ALTER TABLE agentscan_outbox
  ADD CONSTRAINT agentscan_outbox_source_reference
  CHECK (
    (source_kind = 'agent_activity' AND activity_id IS NOT NULL AND lighter_fill_id IS NULL
     AND enrichment_revision IS NULL)
    OR (source_kind = 'lighter_fill' AND lighter_fill_id IS NOT NULL AND activity_id IS NULL
        AND enrichment_revision IS NULL)
    OR (source_kind = 'lighter_fill_enrichment' AND lighter_fill_id IS NOT NULL AND activity_id IS NULL
        AND enrichment_revision IS NOT NULL)
  );

-- The existing UNIQUE (activity_id, status) keeps the activity diff scan
-- idempotent; a fill needs the same guarantee in its own id space, and an
-- ENRICHMENT of that fill is a different row with the same fill id, so the
-- revision is part of the pair. `COALESCE(..., 0)` gives the fill's own row a
-- revision slot of 0 that no enrichment can occupy (the column CHECK admits
-- only revisions above zero), so the two kinds can never collide.
DROP INDEX IF EXISTS uniq_agentscan_outbox_lighter_fill_pair;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agentscan_outbox_lighter_fill_pair
  ON agentscan_outbox (lighter_fill_id, source_kind, status, COALESCE(enrichment_revision, 0))
  WHERE lighter_fill_id IS NOT NULL;

COMMENT ON COLUMN agentscan_outbox.source_kind IS
  'Which local ledger this row reports: agent_activity, the Lighter fill ledger, or an enrichment of one already-delivered fill.';
COMMENT ON COLUMN agentscan_outbox.enrichment_revision IS
  'The lighter_fills.revision an enrichment row delivers. NULL on every other row kind.';

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
