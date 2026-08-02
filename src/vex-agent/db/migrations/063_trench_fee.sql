-- 063: Vex's 25 bps integrator fee on Trench Express — the `trench_fee`
-- activity role, plus two additive columns/indexes migration 062 left open.
--
-- ── NUMBERING ──────────────────────────────────────────────────────────────
--
-- 062 is the last file and ships in the same wave as this one. `db/migrate.ts`
-- applies only migrations whose version is GREATER than `MAX(schema_version)`,
-- so 063 is forward-only for every history that has run 061 or 062. Verified
-- 2026-08-02: no sibling file claims 063.
--
-- ── WHY THE FEE NEEDS A ROLE OF ITS OWN ────────────────────────────────────
--
-- Vex charges 25 bps on the ETH leg of every Trench Express action. The Trench
-- Diamond exposes NO integrator-fee parameter (unlike KyberSwap's `feeReceiver`
-- or Jupiter's referral account), so the fee can only be Vex's OWN native
-- transfer — a SEPARATE transaction, signed AFTER the trade or launch confirms.
--
-- A separate transaction needs its own `agent_activity` row: it has its own
-- hash, its own nonce, and its own success/failure. It must NOT instead be
-- recorded through the `vex_fee_*` columns (`AgentActivityVexFeeCharge`), which
-- exist for venues that take the fee INSIDE the transaction being recorded and
-- where it therefore has no row. Setting both would store the same money twice —
-- `db/repos/agent-activity/types.ts` states this rule explicitly.
--
-- `bridge_fee` CANNOT be reused for that row, and this is the fact that forces
-- a migration rather than a code change: `agent_activity_kind_role_binding`
-- admits `bridge_fee` ONLY on the `kind = 'bridge'` arm. A Trench fee row
-- carries `kind = 'swap'` (a trade) or `kind = 'launch'` (a launch), so the
-- database would reject it. Reusing it would also be untrue: the bridge repair
-- sweeps and the bridge feed both select on `bridge_*` roles, and a Trench row
-- appearing in that population is a defect waiting to happen.
--
-- So `trench_fee` joins the role vocabulary and BOTH the `swap` and the `launch`
-- arms of the binding. Both arms, deliberately: a trade fee rides a `swap`
-- execution and a launch fee rides a `launch` one, and they are the same leg.
--
-- Not added to any other arm. A `trench_fee` row on a `bridge`, `lend`,
-- `prediction`, `wrap` or `yield` execution would be a mislabelling, and the
-- CHECK is what makes that a database fact rather than a convention.
--
-- Local signing: `trench_fee` is added to `hashless-recovery.ts`'s
-- `LOCALLY_SIGNABLE_ACTIVITY_ROLES` in the same change, beside `bridge_fee`. A
-- fee leg planned but never signed — because the trade reverted, or the process
-- died between intent creation and staging — is definitively not-attempted and
-- must stay reapable instead of pending forever.
--
-- No new `kind`: the fee always belongs to an existing `swap` or `launch`
-- execution. No new `failure_code`: `mined_revert`, `broadcast_error` and
-- `unknown` already describe every way a plain value transfer can fail.
--
-- EXPAND-ONLY. New vocabulary members, new nullable column, new index; no
-- backfill, no column dropped, no predicate narrowed. Rollback is clean only
-- while no `trench_fee` row exists.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

-- ── 1. `trench_fee` joins the role vocabulary ───────────────────────────────

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
        'wrap', 'unwrap',
        'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim',
        'token_launch',
        'trench_fee'
      ));
  END IF;
END$$;

-- ── 2. `trench_fee` on the `swap` AND `launch` arms of the binding ──────────
--
-- Re-stated in full (the drop-and-re-add-named pattern of 034/035/045/049/050/
-- 062): a CHECK cannot be amended in place, so the whole predicate is rewritten
-- with the two arms widened and every other arm byte-identical to 062.

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_role_binding') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_role_binding
      CHECK (
        (kind = 'swap'   AND event_role IN ('allowance_reset', 'allowance', 'swap', 'trench_fee'))
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

-- ── 3. `token_launch_intents.authorization_json` — the C0 audit record ──────
--
-- Migration 062 persists only `authorization_id` and `authorization_kind`. The
-- §C0 authorization record binds considerably more: the image DIGEST (the row
-- carries only `image_id`), the anchored creation fee and the block it was read
-- at, the exact `msg.value`, the create-calldata fingerprint, the permission at
-- authorization time, plus mission provenance for `full_autonomy` and the
-- policy snapshot for `approval_card`. None of that has anywhere to live.
--
-- WHAT THIS COLUMN BUYS, precisely, because the distinction is what justifies
-- it: AUDIT, not authorization integrity. Nothing on the signing path reads
-- this blob. The gate remains re-derivation-and-compare against freshly read
-- values plus the existing single-use CAS on `authorization_id`. This column
-- exists so a reviewer can reconstruct months later exactly what was authorized,
-- without walking the chain — and so a drift investigation has the authorized
-- side of the comparison in the same row as its outcome.
--
-- Nullable with no backfill: nothing has launched, so every existing row is
-- legitimately NULL, and a NOT NULL would be a lie about rows written before
-- the record existed.

ALTER TABLE token_launch_intents ADD COLUMN IF NOT EXISTS authorization_json JSONB;

COMMENT ON COLUMN token_launch_intents.authorization_json IS
  'The full C0 authorization record as persisted at authorization time (image digest, anchored creation fee + block, msg.value, calldata fingerprint, permission, mission/approval provenance). AUDIT ONLY: the signing path re-derives and compares against fresh reads and CAS-consumes authorization_id; nothing reads this blob to decide whether to sign.';

-- ── 4. `token_launch_intents` mission-run index — the launch-count ceiling ──
--
-- 062's indexes cover session / awaiting-form / broadcast-pending. The §C6b
-- launch-COUNT ceiling asks a different question:
--
--   WHERE mission_run_id = ? AND status IN
--     ('authorized','consuming','broadcast_pending','confirmed')
--
-- which is currently a sequential scan. That query runs INSIDE the session
-- control lock immediately before an autonomous launch signs, so a scan there
-- lengthens the window every concurrent launch is serialized behind. In-flight
-- statuses must be counted (or two concurrent launches race past the cap),
-- which is why the index is on the plain column and not partial on `confirmed`.

CREATE INDEX IF NOT EXISTS token_launch_intents_mission_run_idx
  ON token_launch_intents (mission_run_id, status)
  WHERE mission_run_id IS NOT NULL;
