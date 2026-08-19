-- 079: `agent_activity` admits an EVM lend execution (Morpho, batch E3).
--
-- Date: 2026-08-17. Owner approval: "zatwierdzam kierunek, buduj" (E3a, the
-- agentscan schema batch of the Morpho integration plan).
--
-- ── NUMBERING ──────────────────────────────────────────────────────────────
--
-- `db/migrate.ts` applies only migrations whose version is GREATER than
-- `MAX(schema_version)`, so this file is forward-only for every history that
-- has run 078. Verified 2026-08-17: 078 is the highest sibling and no file
-- claims 079.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
--
-- Morpho is EVM variable-rate lending. Today the ledger structurally FORBIDS
-- an EVM lend row, on two independent CHECKs:
--
--   1. `agent_activity_kind_family_binding` (049) pins BOTH `lend` and
--      `prediction` to `chain_family = 'solana' AND chain_id = 20011000000`,
--      because the only lend producer at the time was Jupiter on Solana. A
--      Morpho supply on Base (`eip155`, chain_id 8453) is rejected outright.
--   2. `agent_activity_kind_role_binding` (066) admits only
--      `lend_deposit | lend_withdraw | lend_borrow_operate` on the `lend`
--      arm. Solana needs no ERC-20 approvals, so `allowance` /
--      `allowance_reset` were never added there - while the `swap`, `bridge`,
--      `yield` and `launch` arms all carry them. Supplying an ERC-20 to a
--      Morpho vault needs an approval leg with its own hash, nonce and
--      success/failure, hence its own row, exactly as Pendle's yield arm does.
--
-- `prediction` REMAINS PINNED TO SOLANA, deliberately. There is no EVM
-- prediction producer in this repository; widening a constraint for a
-- producer that does not exist would let a future writer file a mislabelled
-- row as a database fact. Widen that arm when, and only when, such a producer
-- lands.
--
-- No new `kind`: `lend` already exists and describes the execution exactly.
-- No new `event_role`: `lend_deposit` / `lend_withdraw` /
-- `lend_borrow_operate` / `allowance` / `allowance_reset` are all already in
-- `agent_activity_event_role_valid` (049/050/066), so that vocabulary CHECK
-- is untouched here. No new `failure_code`: `simulation_reverted`,
-- `mined_revert`, `broadcast_error`, `allowance_or_balance`,
-- `confirmation_timeout` and `unknown` already describe every way a Morpho
-- supply, withdraw or approval can fail.
--
-- ── EXACT PREDICATE DELTA ──────────────────────────────────────────────────
--
-- `agent_activity_kind_family_binding`
--   OLD (049):
--     kind NOT IN ('lend', 'prediction')
--     OR (chain_family = 'solana' AND chain_id = 20011000000)
--   NEW:
--     kind NOT IN ('lend', 'prediction')
--     OR (chain_family = 'solana' AND chain_id = 20011000000)
--     OR (kind = 'lend' AND chain_family = 'eip155')
--   Delta: one added disjunct. `lend` may now also live on ANY `eip155`
--   chain id (Morpho is deployed on several; pinning a chain-id allowlist
--   here would need a migration per deployment, and the venue's own routing
--   already decides which chains it supports). `prediction` is unchanged in
--   both directions: still Solana-only, still that one synthetic chain id.
--
-- `agent_activity_kind_role_binding`
--   OLD `lend` arm (066):
--     (kind = 'lend' AND event_role IN
--       ('lend_deposit', 'lend_withdraw', 'lend_borrow_operate'))
--   NEW `lend` arm:
--     (kind = 'lend' AND event_role IN
--       ('allowance_reset', 'allowance',
--        'lend_deposit', 'lend_withdraw', 'lend_borrow_operate'))
--   Delta: two added roles on that arm, mirroring the `bridge` / `yield`
--   arms. EVERY OTHER ARM IS BYTE-IDENTICAL TO 066 - a CHECK cannot be
--   amended in place, so the whole predicate is restated with the
--   drop-and-re-add-named pattern of 034/035/045/049/050/062/063/066.
--
-- ── OTHER INVARIANTS AN EVM LEND ROW MUST STILL SATISFY (unchanged here) ───
--
--   * `agent_activity_evm_signed_leg_has_nonce` (045) - a staged EVM lend row
--     with a `tx_hash` and no `evidence_source` MUST carry a nonce. The
--     writer therefore uses `markActivityBroadcast`, never the Solana
--     variant.
--   * `agent_activity_solana_no_nonce` (045) - unaffected: an EVM row is
--     exempt by family.
--   * `agent_activity_solana_staged_has_evidence` (049) - unaffected: scoped
--     to `chain_family = 'solana'`, so an EVM lend row needs neither
--     `recent_blockhash` nor `last_valid_block_height`.
--   * `agent_activity_non_bridge_no_bridge_cols` (049) - ACTIVELY APPLIES: an
--     EVM lend row must leave all ten bridge-only columns NULL.
--   * `agent_activity_confirmed_has_hash` / `_failed_has_code` /
--     `_pending_has_no_terminal_fields` (044, kept by 061) - apply unchanged.
--
-- ── SAFETY ────────────────────────────────────────────────────────────────
--
-- EXPAND-ONLY. Both predicates gain disjuncts and neither loses one, so every
-- row that satisfied the old CHECK satisfies the new one BY CONSTRUCTION - no
-- backfill, no data mutation, no column added or dropped, no narrowing. Both
-- constraints therefore re-add VALIDATING (no `NOT VALID` needed): the scan
-- of existing rows cannot fail. Rollback to the 049/066 predicates is clean
-- only while no `eip155` lend row and no `lend` allowance row exist.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

-- ── 1. `lend` may live on eip155; `prediction` stays Solana-only ────────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_family_binding;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_family_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_family_binding
      CHECK (
        kind NOT IN ('lend', 'prediction')
        OR (chain_family = 'solana' AND chain_id = 20011000000)
        OR (kind = 'lend' AND chain_family = 'eip155')
      );
  END IF;
END$$;

-- ── 2. Approval legs on the `lend` arm of the kind<->role binding ───────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_role_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_role_binding
      CHECK (
        (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap', 'trench_fee', 'swap_fee'))
        OR
        (kind = 'bridge' AND event_role IN (
          'allowance_reset', 'allowance',
          'bridge_deposit', 'bridge_fee',
          'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
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
          'token_launch', 'trench_fee'
        ))
      );
  END IF;
END$$;
