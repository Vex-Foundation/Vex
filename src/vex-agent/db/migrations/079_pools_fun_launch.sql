-- 079_pools_fun_launch.sql - pools.fun launches and fee claims
--
-- WHAT THIS ADDS, and why each piece is the shape it is.
--
-- 1. A PROTOCOL DISCRIMINATOR on `token_launch_intents`. The owner's decision
--    (2026-08-18) is that pools.fun reuses Trench's dedicated C0 launch
--    authorization machine rather than `swap_prequotes`: the state machine, the
--    single-use authorization, the resume path and the expiry sweep are all
--    exactly what a launch needs, and a second copy of them would be a second
--    place for the money path to drift. What the table lacked was a way to say
--    WHICH launchpad a row belongs to. Existing rows are all Trench, so the
--    DEFAULT is the honest backfill and no UPDATE is needed.
--
-- 2. THE POOLS FIELDS, all nullable. A Trench intent has none of them, and a
--    NOT NULL column with a meaningless default would assert something false
--    about every historical row.
--
-- 3. THE `previewed` STATUS, non-live BY CONSTRUCTION (decision 7). Preview on
--    pools.fun is ADVISORY: the image determines the metadata URI, which
--    determines the salt, which determines the token address, so the address a
--    preview shows is not the address a launch produces. The row exists so
--    Agent Scan can surface previews from intents rather than from hashless
--    activity rows - and the CHECK below is what makes "carries no
--    authorization and no hash" a database fact instead of a convention a later
--    handler could forget.
--
-- 4. VOCABULARY ONLY for the claim. `agent_activity` already has
--    `token_out2_*` / `amount_out2_*` / `executed_amount_out2_*` from migration
--    053 (the Pendle dual-instrument work), which is exactly what a
--    two-asset claim needs: ONE activity row with two output legs. So the claim
--    needs no new columns - only a role, and a `kind` arm to hang it on.
--
--    `pools_claim` rides its OWN `kind = 'claim'` (owner decision 2026-08-19,
--    superseding this file's earlier draft, which filed it under `launch` on
--    063's precedent). A payout is not a launch: it signs its own transaction
--    long afterwards, spends nothing, and pays two assets out, so filing it
--    under `launch` would put it inside every launch feed, filter and count.
--    This is the ONE non-additive part of the package, and the audit it demands
--    was done in the same change: the transactions feed, the Agent Scan feed,
--    the token history (declared a gap, not a silent one), the mutation matrix
--    and BOTH vocabulary mirrors each name `claim` explicitly. `pools_fee`
--    stays on the `launch` arm - it is the fee leg OF a launch.
--
-- EXPAND-ONLY EXCEPT FOR THE CLAIM KIND ABOVE. New nullable columns, new
-- vocabulary members, and new
-- constraints that constrain only NEW states. No backfill, no column dropped,
-- no existing predicate narrowed. Rollback is clean while no `pools_fun` intent
-- and no `pools_fee`/`pools_claim` activity row exists.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final, and keep `vex-app/src/shared/agent-activity-vocabulary.ts` in step in
-- the SAME change - the vocabulary and its mirror are one fact.

-- ── 1. Protocol discriminator ───────────────────────────────────────────────

ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS protocol TEXT NOT NULL DEFAULT 'trench';

ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_protocol_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_protocol_check
  CHECK (protocol IN ('trench', 'pools_fun'));

-- ── 2. pools.fun launch fields ──────────────────────────────────────────────
--
-- `paired_asset` is the SYMBOLIC pair as the provider names it;
-- `paired_asset_address` is the address the verifier proved it maps to. Both
-- are stored because the verifier's job is to show they agree, and a record
-- that kept only one could not be audited afterwards.
--
-- `fee_recipient_address` is the RESOLVED address. On an agent launch it is the
-- session wallet (pinned by the system, never a tool parameter); on the manual
-- form path the user may name an address or an X username, and what is stored
-- is what the resolution produced and the user confirmed.

ALTER TABLE token_launch_intents
  ADD COLUMN IF NOT EXISTS paired_asset            TEXT,
  ADD COLUMN IF NOT EXISTS paired_asset_address    TEXT,
  ADD COLUMN IF NOT EXISTS fee_recipient_address   TEXT,
  ADD COLUMN IF NOT EXISTS metadata_uri            TEXT,
  ADD COLUMN IF NOT EXISTS image_url               TEXT,
  ADD COLUMN IF NOT EXISTS predicted_token_address TEXT,
  ADD COLUMN IF NOT EXISTS gateway_address         TEXT,
  ADD COLUMN IF NOT EXISTS deployment_fee_wei      TEXT;

-- Only WETH and USDG are launchable on PartyFactory today: `allowedPairedAsset`
-- returns false for the tokenised stocks, and the AAPL-paired rows in discover
-- belong to the OLDER sushi launcher. 'stock' therefore stays OUT of the
-- vocabulary until a real stock address passes the live check - a value the
-- database refuses is better than a launch that reverts.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_paired_asset_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_paired_asset_check
  CHECK (paired_asset IS NULL OR paired_asset IN ('weth', 'usdg'));

-- A pools.fun launch without a pair is not a launch; a Trench launch has no
-- pair at all (its curve is ETH by construction).
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_pools_has_pair;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_pools_has_pair
  CHECK (protocol <> 'pools_fun' OR paired_asset IS NOT NULL);

-- ── 3. The `previewed` status ───────────────────────────────────────────────
--
-- Dropped and re-added rather than edited: a CHECK cannot be extended in place.
-- Every previously admitted value is carried across unchanged (072's list) plus
-- the new one.

ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_status_check;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_status_check
  CHECK (status IN (
    'previewed',
    'awaiting_user_form',
    'authorized',
    'consuming',
    'broadcast_pending',
    'confirmed',
    'terminal_failure',
    'cancelled',
    'expired',
    'superseded_unproven'
  ));

-- THE NON-LIVE PROPERTY, as a database fact.
--
-- A previewed row carries NO authorization and NO hash. That is what makes it
-- impossible to mistake for a launch that was authorized or broadcast, and it
-- is the structural half of "a preview cannot transition directly to signing":
-- the signing path CAS-consumes an `authorization_id`, and a previewed row has
-- none to consume, so a real launch must start a fresh intent.
--
-- Retention needs nothing new here: `expires_at` is already NOT NULL on this
-- table and the existing expiry sweep indexes it, so a previewed row ages out
-- with every other kind.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_previewed_is_not_live;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_previewed_is_not_live
  CHECK (status <> 'previewed' OR (authorization_id IS NULL AND tx_hash IS NULL));

-- ... AND `previewed` MUST JOIN THE PRE-AUTHORIZATION EXITS, or the row above
-- can never exist.
--
-- Migration 062's `token_launch_intents_live_has_authorization` says: a row is
-- either in one of the pre-authorization states, or it names the C0
-- authorization it was authorized under. `previewed` was in neither list, so it
-- was treated as a LIVE state and required an authorization - while the
-- constraint immediately above forbids one. The two are mutually
-- unsatisfiable: every INSERT of a previewed row was refused, whatever it
-- carried.
--
-- This was found by APPLYING the migration to a real Postgres and inserting the
-- rows (`agents_dm/pools-fun-live/migration-079-apply-proof.ts`). A green test
-- suite cannot find it - no unit test exercises DDL, and the defect lives in
-- the interaction between a new constraint and a two-year-old one.
--
-- `previewed` belongs on that list on the merits, not just to unblock the
-- insert: it is a PRE-authorization state by construction, exactly like
-- `awaiting_user_form`. The list is restated in full because a CHECK cannot be
-- extended in place; every existing member is carried across unchanged.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_live_has_authorization;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_live_has_authorization
  CHECK (
    status IN ('previewed', 'awaiting_user_form', 'cancelled', 'expired')
    OR (authorization_id IS NOT NULL AND authorization_kind IS NOT NULL)
  );

-- Same reasoning for the unsigned exits: nothing is ever signed for a preview,
-- so it may not carry a hash. `token_launch_intents_previewed_is_not_live`
-- already says this, and stating it here too keeps the two lists honest about
-- the same fact rather than leaving `previewed` looking like an oversight to
-- the next reader of 062's constraint.
ALTER TABLE token_launch_intents DROP CONSTRAINT IF EXISTS token_launch_intents_unsigned_exits_have_no_hash;
ALTER TABLE token_launch_intents
  ADD CONSTRAINT token_launch_intents_unsigned_exits_have_no_hash
  CHECK (status NOT IN ('previewed', 'cancelled', 'expired') OR tx_hash IS NULL);

-- Agent Scan lists previewed intents separately from live ones, and the expiry
-- sweep walks them; both read (status, created_at).
CREATE INDEX IF NOT EXISTS idx_token_launch_intents_previewed
  ON token_launch_intents (session_id, created_at DESC)
  WHERE status = 'previewed';

-- ── 4. Activity vocabulary: `pools_fee` and `pools_claim` ───────────────────
--
-- `pools_fee` is the Vex integrator fee leg on a pools.fun launch. It cannot
-- reuse `trench_fee`: that role names a different venue, and the Trench feeds
-- and repair sweeps select on it - a pools row appearing in that population is
-- a defect waiting to happen, exactly as 063 said about reusing `bridge_fee`.
--
-- `pools_claim` is the fee claim: ONE row whose two OUTPUT legs are the two
-- assets `collectAndClaim` returns (the launched token and the paired asset),
-- using the `*_out2_*` columns migration 053 already added. It rides its own
-- `kind = 'claim'` (section 4b), NOT `kind = 'launch'`.
--
-- Local signing: `pools_fee` joins `hashless-recovery.ts`'s
-- `LOCALLY_SIGNABLE_ACTIVITY_ROLES` in the same change, beside `trench_fee` and
-- `bridge_fee`. A fee leg planned but never signed - because the launch
-- reverted, or the process died between intent creation and staging - is
-- definitively not-attempted and must stay reapable instead of pending forever.
-- `pools_claim` does NOT join that list: it is the primary transaction of its
-- own execution, not a dependent leg.

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
    'pools_fee', 'pools_claim'
  ));

-- The binding is restated in full - a CHECK cannot be extended in place - with
-- every existing arm carried across byte-for-byte from MIGRATION 066 (the
-- current state, not 063: 066 added `swap_fee` to the vocabulary and to the
-- `swap` arm, and restating 063's older list here would have SILENTLY DROPPED
-- it and made every Uniswap fee row unwritable). Only the `launch` arm is
-- widened.
-- ── 4b. `claim` is its OWN kind (owner decision 2026-08-19) ────────────────
--
-- A creator-fee claim is not a launch. It signs its own transaction, pays two
-- assets, spends nothing, and happens months after the launch it belongs to -
-- so filing it under `kind='launch'` would put a payout inside the population
-- every launch feed, launch filter and launch ceiling reads. This is the one
-- NON-ADDITIVE part of 079: every consumer that switches on `kind` must handle
-- 'claim' rather than fall through, and each one was audited in the same change.
--
-- `pools_fee` deliberately STAYS on the `launch` arm: it is the Vex integrator
-- fee leg OF a launch, taken after that launch confirms, and it belongs with the
-- transaction it charges for.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_kind_valid
  CHECK (kind IN ('swap', 'bridge', 'lend', 'prediction', 'wrap', 'yield', 'launch', 'claim'));

-- The `claim` arm carries exactly ONE role. A claim is a single transaction
-- that pays out: no allowance step (nothing is spent, so nothing is approved),
-- and no fee leg of its own. The CHECK body itself stays comment-free and
-- apostrophe-free, because the constraint evaluators that test these bindings
-- parse the body as SQL rather than as prose.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_role_binding;
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
      'token_launch', 'trench_fee',
      'pools_fee'
    ))
    OR
    (kind = 'claim' AND event_role IN ('pools_claim'))
  );

-- ── 5. `pools_claim` may carry the SECOND OUTPUT LEG it is defined by ───────
--
-- Migration 053 bound the `*_in2_*` / `*_out2_*` columns to `yield_py` and
-- `yield_lp` ONLY, deliberately: fourteen unconstrained nullable columns would
-- otherwise become a general-purpose second leg any writer could populate on any
-- role. That allowlist is still right, and `pools_claim` has to be ADDED to it
-- rather than assumed into it - section 4 above says the claim's two output legs
-- ride these columns, and without this the constraint would reject exactly the
-- row that section describes. A migration whose prose and whose CHECK disagree
-- is worse than either alone.
--
-- The INPUT second leg stays forbidden for `pools_claim`, and that asymmetry is
-- the point: `collectAndClaim` spends nothing and pays two assets, so an input
-- leg on a claim row would be evidence the decoder read the wrong thing.
--
-- The predicate is restated in full because a CHECK cannot be extended in
-- place; the `yield_py` / `yield_lp` arms are carried across byte-for-byte.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_second_leg_roles_only;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_second_leg_roles_only
  CHECK (
    event_role IN ('yield_py', 'yield_lp')
    OR (
      event_role = 'pools_claim'
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
