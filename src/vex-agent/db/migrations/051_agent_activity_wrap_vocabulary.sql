-- Agent Scan — a vocabulary for wrapping and unwrapping native assets.
--
-- WHY THIS EXISTS: Vex is gaining a first-class wrap/unwrap capability (SOL↔WSOL,
-- ETH↔WETH, BNB↔WBNB, and every other EVM chain's registry wrapped-native), and
-- `agent_activity` has no honest way to record one. The `kind` set is
-- swap/bridge/lend/prediction and no `event_role` describes the operation.
--
-- The tempting shortcut is to record a wrap as `kind='swap'`. That is rejected
-- for two independent reasons:
--
--   1. It would be FALSE. A swap asserts that a route was found across venues,
--      that a price was quoted, that slippage applied and that a counterparty
--      took the other side. A wrap is a 1:1 deposit into a wrapper contract (or
--      an SPL account close). No route, no venue, no price, no slippage. Every
--      swap-shaped consumer — analytics, the agent's own reading of its history,
--      the settlement decoders — would be reasoning about a trade that never
--      happened.
--   2. It would fight `agent_activity_confirmed_swap_has_executed_legs` (044) in
--      the wrong direction. That constraint is scoped `event_role <> 'swap'`, so
--      mislabelling would attach a swap-only invariant to a non-swap operation.
--
-- So: a new `kind`, two new roles, and one new invariant of its own.
--
-- ── What this is NOT ─────────────────────────────────────────────────────────
--
-- No Vex fee is taken on a wrap, and no `vex_fee_*` column is written by this
-- path. A wrap extracts no value: it is a utility conversion the user needs in
-- order to use their own asset (Jupiter Lend Borrow rejects native SOL legs, and
-- an EVM wrapped-native balance cannot pay for gas). Charging 25 bps to make an
-- asset usable would also break the amount relationship below. Stated here
-- because "every other mutation takes a fee" is the wrong inference to draw.
--
-- ── The amount relationship is NOT 1:1 on Solana, and the schema must not
--    pretend otherwise ────────────────────────────────────────────────────────
--
-- EVM is clean: `WETH.deposit()` and `WETH.withdraw(amount)` move exactly
-- `amount` in each direction.
--
-- Solana is not. The owner's decision is UNWRAP-ALL — closing the WSOL account,
-- which is the protocol's own shape; there is no partial close. Closing returns
-- the wrapped lamports **plus the rent-exempt reserve** (~0.00203928 SOL), so the
-- SOL received strictly EXCEEDS the WSOL unwrapped. That is correct and expected:
-- the rent was the user's, posted when the account was created, and is being
-- returned.
--
-- Therefore the new invariant below requires both executed legs to be PRESENT on
-- a confirmed row, and deliberately does NOT require them to be EQUAL. A future
-- reader must not "tighten" this into an equality check; it would refuse every
-- honest Solana unwrap.
--
-- ── Constraint interaction, verified against the live schema rather than
--    assumed ─────────────────────────────────────────────────────────────────
--
-- Three constraints need widening: `agent_activity_kind_valid`,
-- `agent_activity_event_role_valid`, `agent_activity_kind_role_binding`.
-- Every other CHECK on the table was enumerated and checked against a wrap row:
--
--   * `agent_activity_kind_family_binding` (049) — scoped to lend/prediction, so
--     it does NOT pin wrap to Solana. Correct: wrap is the one mutation kind that
--     is genuinely dual-family.
--   * `agent_activity_bridge_has_route`      — scoped `kind <> 'bridge'`. Exempt.
--   * `agent_activity_non_bridge_no_bridge_cols` — ACTIVELY APPLIES: a wrap row
--     must leave from/to chain, provider_order_id, normalized_route,
--     provider_status, last_attempted_at, evidence_source and observed_at NULL.
--     The writer must not set them; the constraint will catch it if it does.
--   * `agent_activity_normalized_route_logical_only` (045) — biconditional on
--     `bridge_fill_expected`; a wrap row carries `normalized_route IS NULL`. OK.
--   * `agent_activity_logical_has_session` / `_order_id_logical_only` (045) —
--     both scoped to the logical bridge row. Exempt.
--   * `agent_activity_confirmed_swap_has_executed_legs` (044) — scoped
--     `event_role <> 'swap'`, so it does not cover wrap. That is the gap this
--     migration closes with its own constraint rather than by editing 044's.
--   * `agent_activity_solana_no_nonce` (049) — a Solana wrap must carry
--     `nonce IS NULL`; an EVM wrap must carry one to satisfy
--     `agent_activity_evm_signed_leg_has_nonce`.
--   * `agent_activity_solana_staged_has_evidence` (049) — a staged Solana wrap
--     must persist `recent_blockhash` + `last_valid_block_height`, exactly as the
--     other Solana legs do.
--   * `agent_activity_failure_code_valid` — needs NO new code. A wrap fails as
--     `allowance_or_balance` (insufficient balance), `mined_revert`,
--     `broadcast_error`, `confirmation_timeout` or `solana_signature_expired`.
--
-- ── Allowance legs are deliberately absent from the wrap arm ─────────────────
--
-- Neither direction needs an ERC-20 approval. `deposit()` is payable and
-- `withdraw()` burns the caller's own balance; on Solana, closing an account the
-- wallet owns needs no delegate. If a future change appears to need an allowance
-- leg here, that is a signal the design drifted, not a reason to widen the arm.
--
-- ── Compatibility and rollback ───────────────────────────────────────────────
--
-- Every widening is a strict SUPERSET of the previous predicate, so every
-- existing row stays valid and no backfill is needed. Old code never writes
-- `kind='wrap'`, so old-code/new-schema is safe. New code against an un-migrated
-- database fails the CHECK loudly rather than writing a bad row — which is the
-- desired direction.
--
-- Rollback is only clean while no wrap row exists. Once one does, restoring the
-- narrow predicates requires deleting those rows first. Stated so nobody
-- discovers it during an incident.
--
-- ── This CHECK is a floor, not the contract (Codex review, 2026-07-25) ───────
--
-- A CHECK constraint cannot express "1:1 on EVM, out-exceeds-in-by-rent on
-- Solana", because the correct relationship differs per family. So constraint 4
-- below proves only that both legs are PRESENT. It still permits a confirmed
-- wrap recording `0 → 0`, `1 → 0`, or an inverted pair.
--
-- The real contract therefore belongs in the finalizer, beside the swap-specific
-- guard that already lives in `db/repos/agent-activity/swap-lifecycle.ts:173`:
--
--   * EVM wrap and unwrap  — exact, positive, 1:1 raw amounts.
--   * Solana wrap          — exact, positive, 1:1 after network-fee and
--                            persistent-account-rent treatment.
--   * Solana unwrap-all    — positive, with `out > in`; the difference is
--                            emitted as explicitly-labelled RETURNED RENT, never
--                            as gain.
--   * Undecodable, or directionally wrong — stays `pending`. It is not a
--     terminal failure; we could not read it, which is not the same as it having
--     failed.
--
-- Do not treat this constraint as sufficient because it is the thing the
-- database enforces. It is the part the database CAN enforce.
--
-- ── Required companion changes, NOT in this file ─────────────────────────────
--
-- Enumerated with Codex; the first item alone is not enough.
--
--  1. THREE agent-visible SQL surfaces, not one. `transactions-query-builder.ts:90`,
--     `vex-app/src/main/database/moves-db-query.ts:287` and
--     `vex-app/src/main/database/token-history-db-query.ts:444` currently omit
--     wrap or map it through `ELSE 'spot'`. Until all three know the kind, a
--     wrap row is written correctly and is INVISIBLE — or worse, is displayed as
--     a spot trade.
--  2. `db/repos/agent-activity/types.ts:20` — the TypeScript vocabulary.
--  3. `db/repos/agent-activity/hashless-recovery.ts:74` — the stale-hashless
--     local-signing allowlist. Without the new roles, a crash before staging
--     leaves a wrap row pending forever with nothing able to reap it.
--  4. `sync/solana-settlement-dispatch.ts:45` needs a wrap arm. The generic
--     decoder takes an ABSOLUTE VALUE, so it cannot establish wrap direction.
--  5. `tools/protocols/mutation-matrix.ts:95`, the product filters, the desktop
--     DTO tests and the feed chips. Reusing the same-chain DTO shape is fine,
--     but `productType` must be `wrap` — never `spot`.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

-- ── 1. `wrap` joins the kind vocabulary ─────────────────────────────────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_valid
      CHECK (kind IN ('swap', 'bridge', 'lend', 'prediction', 'wrap'));
  END IF;
END$$;

-- ── 2. `wrap` and `unwrap` join the role vocabulary ─────────────────────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_event_role_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_event_role_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_event_role_valid
      CHECK (event_role IN (
        'allowance_reset', 'allowance', 'swap',
        'bridge_deposit', 'bridge_fee', 'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund',
        'lend_deposit', 'lend_withdraw', 'lend_borrow_operate',
        'predict_buy', 'predict_sell', 'predict_claim', 'predict_close',
        'wrap', 'unwrap'
      ));
  END IF;
END$$;

-- ── 3. The two new roles join the WRAP arm only ─────────────────────────────
--
-- A swap/bridge/lend/prediction row can never carry `wrap`/`unwrap`, and a wrap
-- row can never carry any other role — including the allowance roles, per the
-- reasoning above.

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
          'bridge_deposit', 'bridge_fee',
          'bridge_fill_expected', 'bridge_fill_observed', 'bridge_refund'
        ))
        OR
        (kind = 'lend' AND event_role IN ('lend_deposit', 'lend_withdraw', 'lend_borrow_operate'))
        OR
        (kind = 'prediction' AND event_role IN (
          'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
        ))
        OR
        (kind = 'wrap' AND event_role IN ('wrap', 'unwrap'))
      );
  END IF;
END$$;

-- ── 4. A confirmed wrap must state what actually moved ──────────────────────
--
-- The sibling of 044's swap invariant, scoped to the new roles. A wrap that
-- cannot be decoded stays `pending` rather than confirming with an unknown
-- amount — the same decline-rather-than-guess doctrine the Solana settlement
-- decoders already follow.
--
-- Deliberately NOT an equality check: a Solana unwrap returns the rent reserve
-- on top of the wrapped lamports (see the header). Requiring in == out would
-- refuse every honest close.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_confirmed_wrap_has_executed_legs'
  ) THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_confirmed_wrap_has_executed_legs
      CHECK (
        status <> 'confirmed'
        OR event_role NOT IN ('wrap', 'unwrap')
        OR (executed_amount_in_raw IS NOT NULL AND executed_amount_out_raw IS NOT NULL)
      );
  END IF;
END$$;
