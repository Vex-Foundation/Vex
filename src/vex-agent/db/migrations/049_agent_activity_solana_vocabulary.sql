-- Agent Scan Phase 3 (W5) — agent_activity vocabulary widened for Jupiter/
-- Solana (lend, prediction) + the staged-seam evidence columns. Design doc
-- agents_dm/agentscan-phase3/w5-design.md §1/§8 — REVISION 1 R1/R2 + REVISION
-- 2 R2b GOVERN over the base §1-§9 text on conflict; this file implements the
-- REVISED contract.
--
-- ── Vocabulary (R1) ──────────────────────────────────────────────────────
-- `kind` widens to 'swap' | 'bridge' | 'lend' | 'prediction'. Jupiter swaps
-- reuse the EXISTING 'swap' kind (protocol='jupiter', chain_family='solana',
-- chain_id=20011000000 — the repo's existing Khalani-originated Solana
-- synthetic id, now named `SOLANA_SYNTHETIC_CHAIN_ID` in
-- src/constants/solana-chain.ts and pinned against the desktop's
-- `vex-app/src/shared/chains/display.ts` SOLANA_CHAIN_ID by a contract test —
-- R1's "not DB repo types" instruction). `lend`/`prediction` are NEW kinds,
-- each getting their own event_role arms in the kind<->role binding CHECK.
--
-- Failure codes: ONLY `solana_signature_expired` is new (a blockhash-expiry
-- proof, safe because an expired blockhash can never land). R1 corrects the
-- base design's invented codes (`provider_rejected`, `slippage_exceeded`,
-- `pre_broadcast_failure`, `confirmation_unknown_exhausted`) — they do not
-- exist in the real 045 vocabulary and are dropped; `market_closed` /
-- `position_not_found` / `insufficient_collateral` start as structured
-- `failure_reason` text under existing codes, not new enum members (R1).
--
-- `agent_activity_swap_no_bridge_cols` (045) is REPLACED by a NON-BRIDGE
-- invariant (R1): any kind <> 'bridge' (now including 'lend'/'prediction',
-- not just 'swap') must have every bridge-only column NULL. Old and new rows
-- alike satisfy this — behaviorally identical to 045 for 'swap'/'bridge',
-- newly enforced for 'lend'/'prediction'.
--
-- NEW `agent_activity_kind_family_binding`: kind IN ('lend','prediction') =>
-- chain_family='solana' AND chain_id=20011000000. No historical row has
-- either kind (both are new), so this validates cleanly against every
-- existing row without NOT VALID.
--
-- ── Staged seam evidence columns (R2/R2b) ───────────────────────────────
-- `recent_blockhash`/`last_valid_block_height` are the ONLY currency (with
-- the base58 signature already in tx_hash) `prepareVersionedTx`/
-- `markActivitySolanaBroadcast` persist atomically before submit (K2). CHECK
-- scoped to LOCALLY STAGED rows only (R2b, corrected from R2's initial
-- tx_hash-based scoping): chain_family='solana' AND submit_attempted_at IS
-- NOT NULL => both evidence columns NOT NULL. Provider-observed rows
-- (evidence_source set, e.g. confirmBridgeExpectedFill) never set
-- submit_attempted_at (045's `agent_activity_observed_no_local_fields`
-- already enforces that), so they are correctly exempt without a separate
-- clause.
--
-- ADDED `NOT VALID` (builder decision — this file introduces the idiom to
-- the migration set; no prior migration needed it): migration 045 already
-- shipped `markActivitySolanaBroadcast` and Khalani Solana bridge-deposit
-- legs are live, staging real signatures (chain_family='solana',
-- submit_attempted_at set) WITHOUT the two evidence columns, which did not
-- exist before this file. A validating ADD CONSTRAINT would scan and reject
-- on any already-installed self-custodial database with such historical
-- rows, breaking that user's migration run outright — the same "every new
-- CHECK is satisfied by every existing row" discipline 045's header commits
-- to, just achieved via NOT VALID instead of a boolean scoping trick (CHECK
-- has no WHERE clause to exempt "rows written before this migration" any
-- other way). NOT VALID only skips the one-time scan of PRE-EXISTING rows;
-- every INSERT/UPDATE from this migration forward is fully checked,
-- identically to a validated constraint. This is also why the sweep (K3,
-- design R3) is specified to "fail closed (skip + escalate, never guess)" on
-- malformed/missing evidence instead of assuming it can never be missing —
-- that defensive path is precisely the grandfather case this NOT VALID
-- creates for pre-049 rows. DOCS-GAP for the coordinator: flagged in the K1
-- delta log for explicit sign-off since it touches migration/data-safety
-- policy.
--
-- ── Sync job seed ─────────────────────────────────────────────────────────
-- `_global/solana_activity_repair` (K3's future sweep) is seeded via
-- `sync/seed.ts#SYNC_JOBS` (ON CONFLICT DO NOTHING, exactly like every other
-- sync job — 044/045/048 never seed jobs from migration SQL either), NOT
-- from this file. No installed-state work is needed: the job is new, so
-- there is nothing to retire/backfill (contrast 048's hyperliquid job
-- retirement, which acted on rows that already existed).
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final (builder-run per the K1 card instruction).

-- ── 1. Widen the closed vocabularies (drop + re-add named, 034/035/045 pattern) ─

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_valid
      CHECK (kind IN ('swap', 'bridge', 'lend', 'prediction'));
  END IF;
END$$;

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_event_role_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_event_role_valid
      CHECK (event_role IN (
        'allowance_reset', 'allowance', 'swap',
        'bridge_deposit', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
        'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
        'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
      ));
  END IF;
END$$;

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_failure_code_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_failure_code_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_failure_code_valid
      CHECK (failure_code IN (
        'route_not_found', 'slippage', 'deadline_expired',
        'insufficient_liquidity', 'allowance_or_balance',
        'chain_unsupported', 'simulation_reverted', 'mined_revert',
        'broadcast_error', 'confirmation_timeout', 'unknown',
        'bridge_failed', 'bridge_refunded',
        'solana_signature_expired'
      ));
  END IF;
END$$;

-- kind<->event_role binding: two new arms (lend, prediction) alongside the
-- untouched swap/bridge arms.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_role_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_role_binding
      CHECK (
        (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap'))
        OR
        (kind = 'bridge' AND event_role IN (
          'allowance_reset', 'allowance',
          'bridge_deposit', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
        ))
        OR
        (kind = 'lend' AND event_role IN ('lend_deposit', 'lend_withdraw', 'lend_borrow_operate'))
        OR
        (kind = 'prediction' AND event_role IN (
          'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
        ))
      );
  END IF;
END$$;

-- Non-bridge invariant (R1) replaces 045's swap-only
-- `agent_activity_swap_no_bridge_cols`: every kind OTHER than 'bridge' — now
-- including 'lend'/'prediction' — must carry every bridge-only column NULL.
-- Identical behavior to 045 for existing swap/bridge rows.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_swap_no_bridge_cols;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_non_bridge_no_bridge_cols') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_non_bridge_no_bridge_cols
      CHECK (
        kind = 'bridge' OR (
          from_chain_id IS NULL AND from_chain_slug IS NULL
          AND to_chain_id IS NULL AND to_chain_slug IS NULL
          AND provider_order_id IS NULL AND normalized_route IS NULL
          AND provider_status IS NULL AND last_attempted_at IS NULL
          AND evidence_source IS NULL AND observed_at IS NULL
        )
      );
  END IF;
END$$;

-- ── 2. New columns (staged-seam evidence, R2/R2b) — nullable, no backfill needed ─

ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS recent_blockhash         TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS last_valid_block_height  BIGINT;

-- ── 3. New CHECK invariants ──────────────────────────────────────────────

DO $$
BEGIN
  -- kind/family binding (R1): lend and prediction only ever run on the
  -- Solana synthetic chain. No historical row has either kind, so this
  -- validates cleanly without NOT VALID.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_family_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_family_binding
      CHECK (
        kind NOT IN ('lend', 'prediction')
        OR (chain_family = 'solana' AND chain_id = 20011000000)
      );
  END IF;
END$$;

-- Stage-evidence CHECK (R2b, scoped to LOCALLY STAGED rows only) — NOT VALID
-- (see header note): a chain_family='solana' row with a local
-- submit_attempted_at MUST carry both evidence columns; a provider-observed
-- row (evidence_source set) never sets submit_attempted_at, so it is exempt
-- without any extra clause.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_solana_staged_has_evidence') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_solana_staged_has_evidence
      CHECK (
        chain_family <> 'solana'
        OR submit_attempted_at IS NULL
        OR (recent_blockhash IS NOT NULL AND last_valid_block_height IS NOT NULL)
      ) NOT VALID;
  END IF;
END$$;
