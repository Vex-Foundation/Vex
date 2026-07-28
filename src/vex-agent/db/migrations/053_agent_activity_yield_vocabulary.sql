-- 053: `yield` joins the agent_activity vocabulary — Pendle PT/YT/PY/LP/claim.
--
-- Owner decision #3: Pendle records as its OWN kind, `yield`, not folded into
-- `swap`. Folding it in would have been a one-line migration and free inclusion
-- in every existing filter — at the price of asserting a route, a price and a
-- counterparty that `py.mint` (a 1→2 split), `lp.add` (a deposit) and `claim`
-- (an income sweep with NO input leg) never had.
--
-- EXPAND-ONLY. New vocabulary, new nullable columns, new constraints. No
-- backfill: historical Pendle rows in `proj_activity` have no receipt evidence,
-- and a backfilled row would enter `confirmed` on a quote echo — the exact
-- falsification the executed-leg constraints below exist to prevent. The legacy
-- feed halves keep showing them; their `NOT EXISTS` dedupe already prevents
-- double display.
--
-- Rollback is clean only while no `yield` row exists. Once one does, restoring
-- the narrow predicates requires deleting those rows first. Stated so nobody
-- discovers it during an incident.
--
-- ── Option C: the second-leg column family ──────────────────────────────────
--
-- Two Pendle actions are not 1-in-1-out and cannot be told the truth in the
-- existing columns:
--
--   * `py.mint`   — ONE token in, PT **and** YT out   (1 → 2)
--   * `py.redeem` — PT **and** YT in, ONE token out   (2 → 1)
--
-- The alternatives were two rows sharing a tx_hash (a shape NO existing kind
-- has — every tx_hash-keyed consumer, including the feed's own `txHash=` anchor,
-- would have to learn to tolerate a duplicate) or dropping the second
-- instrument entirely (the current capture's falsehood). Option C adds a
-- SYMMETRIC second-leg family, 14 nullable columns mirroring the first leg
-- exactly, so one row states both instruments.
--
-- The columns are bound to `yield_py` and `yield_lp` ONLY (constraint 5). No
-- other role may populate them, so this cannot quietly become a general-purpose
-- second-leg the way an unconstrained nullable column would.
--
-- ── The confirmed-leg predicates are PER ROLE, never generic ────────────────
--
-- A single "confirmed yield must have both executed legs" rule would be WRONG
-- for two of the five roles, and wrong in the dangerous direction — it would
-- make an honest row unwritable and push the finalizer toward inventing a value
-- to satisfy the database:
--
--   * `yield_claim` has NO input leg. A claim sweeps accrued income; nothing is
--     spent. Requiring an executed input would make an output-only confirmation
--     IMPOSSIBLE, which is the one shape a claim always has.
--   * `yield_py` must prove BOTH legs on the side the action populates — both
--     OUTS on a mint, both INS on a redeem — and neither on the side it does
--     not.
--
-- So each role gets its own predicate, gathered into the single constraint
-- `agent_activity_yield_confirmed_legs` (constraint 8), following 051's
-- precedent of adding a SIBLING rather than widening 044's swap invariant.
--
-- ── These CHECKs are a floor, not the contract ──────────────────────────────
--
-- As 051 says of its own: a CHECK proves legs are PRESENT, not that they are
-- RIGHT. It still permits a confirmed `yield_pt` recording `0 → 0`. The real
-- contract belongs in the finalizer beside the swap-specific guard at
-- `db/repos/agent-activity/swap-lifecycle.ts:173`, which is keyed on
-- `event_role === 'swap'` and therefore does NOT cover these roles today.
-- Adding that guard is a REQUIRED companion change, not an optional one.
--
-- ── Constraints verified as already-correct for a yield row ─────────────────
--
--   * `agent_activity_non_bridge_no_bridge_cols` (049) — predicate is
--     `kind = 'bridge' OR (…10 cols NULL)`, so it APPLIES to yield unchanged:
--     a yield row must leave all ten bridge columns NULL. The generic writer
--     never sets them, so this holds for free.
--   * `agent_activity_evm_signed_leg_has_nonce` (045) — Pendle is EVM-only, so
--     a staged yield row MUST carry a nonce. The writer must therefore use
--     `markActivityBroadcast`, never the Solana variant.
--   * `agent_activity_kind_family_binding` (049) — scoped
--     `kind NOT IN ('lend','prediction')`, so `yield` is not pinned to Solana.
--   * `agent_activity_normalized_route_logical_only` (045) — biconditional on
--     `bridge_fill_expected`; a yield row keeps `normalized_route` NULL.
--   * `agent_activity_confirmed_has_hash` (044) — applies unchanged.
--
-- No new `failure_code`: route_not_found / deadline_expired / allowance_or_balance
-- / simulation_reverted / mined_revert / broadcast_error / unknown already cover
-- every Pendle failure. A maturity or price-floor refusal is `failure_reason`
-- text, not a new code.
--
-- `usd_vex_fee_est` / `vex_fee_*` stay NULL — Vex takes no fee on Pendle, and
-- 051 is explicit that "every other mutation takes a fee" is the wrong
-- inference.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is final.

-- ── 1. `yield` joins the kind vocabulary ────────────────────────────────────

ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_kind_valid;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_kind_valid') THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_kind_valid
      CHECK (kind IN ('swap', 'bridge', 'lend', 'prediction', 'wrap', 'yield'));
  END IF;
END$$;

-- ── 2. The six yield roles join the role vocabulary ─────────────────────────
--
-- `yield_sy` is the SY wrapper leg (`pendle.sy.mint` / `pendle.sy.redeem`): a
-- token wrapped into a standardized-yield share, or unwrapped back. It is
-- ONE-IN-ONE-OUT — a wrap, never a split — so it takes the ordinary leg shape
-- and is deliberately NOT admitted to the second-leg family (constraint 5).
-- It gets its own role rather than reusing `yield_pt` because the instrument it
-- moves is not a PT, and a feed that called an SY position a PT position would
-- name a maturity the row does not have.
--
-- `allowance` / `allowance_reset` are REUSED rather than forked into
-- `pendle_allowance`: they are already in the role enum, already in
-- `LOCALLY_SIGNABLE_ACTIVITY_ROLES`, and already handled by the EVM sweep.
-- `ensurePendleAllowanceExact` is the same operation Kyber's plan models.

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
        'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim'
      ));
  END IF;
END$$;

-- ── 3. The yield arm of the kind↔role binding ───────────────────────────────
--
-- A yield row carries a yield role or an allowance role, and nothing else; no
-- other kind may carry a yield role.

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
        OR
        (kind = 'yield' AND event_role IN (
          'allowance_reset', 'allowance',
          'yield_pt', 'yield_yt', 'yield_py', 'yield_lp', 'yield_sy', 'yield_claim'
        ))
      );
  END IF;
END$$;

-- ── 4. Option C: the second-leg columns (14, all nullable) ──────────────────
--
-- Mirrors the first-leg family in `044` exactly, name for name and type for
-- type, so a reader who knows one knows the other.

ALTER TABLE agent_activity
  ADD COLUMN IF NOT EXISTS token_in2_address          TEXT,
  ADD COLUMN IF NOT EXISTS token_in2_symbol           TEXT,
  ADD COLUMN IF NOT EXISTS token_in2_decimals         SMALLINT,
  ADD COLUMN IF NOT EXISTS amount_in2_human           TEXT,
  ADD COLUMN IF NOT EXISTS amount_in2_raw             TEXT,
  ADD COLUMN IF NOT EXISTS executed_amount_in2_human  TEXT,
  ADD COLUMN IF NOT EXISTS executed_amount_in2_raw    TEXT,
  ADD COLUMN IF NOT EXISTS token_out2_address         TEXT,
  ADD COLUMN IF NOT EXISTS token_out2_symbol          TEXT,
  ADD COLUMN IF NOT EXISTS token_out2_decimals        SMALLINT,
  ADD COLUMN IF NOT EXISTS amount_out2_human          TEXT,
  ADD COLUMN IF NOT EXISTS amount_out2_raw            TEXT,
  ADD COLUMN IF NOT EXISTS executed_amount_out2_human TEXT,
  ADD COLUMN IF NOT EXISTS executed_amount_out2_raw   TEXT;

-- ── 5. Second legs belong to `yield_py` and `yield_lp` ONLY ─────────────────
--
-- Without this, 14 unconstrained nullable columns quietly become a
-- general-purpose second leg that any future writer can populate on any role,
-- and the per-role predicates below stop meaning anything.
--
-- The predicate is an ALLOWLIST, so `yield_sy` is excluded by construction and
-- needs no new clause — stated here because "the SY role was forgotten" and
-- "the SY role is forbidden a second leg" read identically in the SQL. It is
-- the latter: an SY wrap moves exactly one instrument on each side.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_second_leg_roles_only'
  ) THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_second_leg_roles_only
      CHECK (
        event_role IN ('yield_py', 'yield_lp')
        OR (
          token_in2_address IS NULL AND token_in2_symbol IS NULL AND token_in2_decimals IS NULL
          AND amount_in2_human IS NULL AND amount_in2_raw IS NULL
          AND executed_amount_in2_human IS NULL AND executed_amount_in2_raw IS NULL
          AND token_out2_address IS NULL AND token_out2_symbol IS NULL AND token_out2_decimals IS NULL
          AND amount_out2_human IS NULL AND amount_out2_raw IS NULL
          AND executed_amount_out2_human IS NULL AND executed_amount_out2_raw IS NULL
        )
      );
  END IF;
END$$;

-- ── 6. A second-leg amount must name its token AND its decimals ─────────────
--
-- rules/90: "raw amounts must travel with the decimals needed to read them".
-- An `amount_out2_raw` with no `token_out2_address` is the canonical
-- thousandfold-error shape — 1047061 is 1.05 at 6 decimals and 0.00105 at 9.
--
-- The ADDRESS alone does not close that hole: a reader holding
-- `("0xyt", "1047061")` still has to go and find the decimals somewhere, and
-- the feed renders from the ROW. So a populated second-leg raw amount requires
-- `token_*2_decimals` too. `0` is a real, valid answer and stays valid — the
-- requirement is NOT NULL, never truthiness (`nullableInt` in `mappers.ts`
-- keeps the same distinction on the read side).
--
-- This is a TIGHTENING over the primary-leg family, which has no decimals arm
-- (044 declares `token_in_decimals`/`token_out_decimals` unconstrained). The
-- asymmetry is deliberate and expand-only: the second-leg columns are brand new
-- and have no historical rows to grandfather, so the invariant can be stated
-- where it costs nothing. Symbols get NO arm, mirroring the primary family
-- exactly — a symbol is a display label, and rules/90 makes display-only fields
-- tolerant while financially-consumed ones stay strict.
--
-- A writer that cannot read a second leg's decimals must therefore leave that
-- leg's raw amount NULL rather than record a number nobody can scale.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_second_leg_amount_has_token'
  ) THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_second_leg_amount_has_token
      CHECK (
        (amount_in2_raw IS NULL AND executed_amount_in2_raw IS NULL)
        OR (token_in2_address IS NOT NULL AND token_in2_decimals IS NOT NULL)
      );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_second_leg_out_amount_has_token'
  ) THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_second_leg_out_amount_has_token
      CHECK (
        (amount_out2_raw IS NULL AND executed_amount_out2_raw IS NULL)
        OR (token_out2_address IS NOT NULL AND token_out2_decimals IS NOT NULL)
      );
  END IF;
END$$;

-- ── 7. `yield_py` is a TWO-INSTRUMENT action, on exactly one side ───────────
--
-- A mint splits one token into PT+YT (second OUT leg); a pre-expiry redeem
-- burns PT+YT into one token (second IN leg). A `yield_py` row with neither is
-- not a PY action — it is a `yield_pt`/`yield_yt`; one with BOTH is a shape no
-- Pendle action produces, and would silently double-count an instrument.
--
-- ONE exemption: a HASHLESS `definitively_failed` row — `status =
-- 'definitively_failed' AND tx_hash IS NULL`, the exact shape
-- `recordPreBroadcastFailure` writes and the only state in the machine that is
-- terminal WITHOUT anything ever having been signed. A PY refusal frequently
-- fires BEFORE the second instrument is known: `pendle.py.mint` and
-- `pendle.py.redeem` refuse on an unresolved market, and the YT address they
-- would name is exactly what that resolution failed to produce. Requiring a
-- second leg there would make an honest refusal UNWRITABLE and push the writer
-- toward inventing an address to satisfy the database — the same failure mode
-- constraint 8 avoids for `yield_claim`, and worse, because the fallback is a
-- funds-untouched refusal vanishing from the feed entirely.
--
-- The exemption is deliberately NOT `status = 'definitively_failed'` alone: a
-- row that WAS broadcast (it carries a hash) and then failed knew both legs
-- when it was staged, and must still prove that shape. Nor does it reach
-- `pending`/`confirmed`, where the row asserts a real PY action.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_yield_py_has_one_second_leg'
  ) THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_yield_py_has_one_second_leg
      CHECK (
        event_role <> 'yield_py'
        OR (status = 'definitively_failed' AND tx_hash IS NULL)
        OR ((token_in2_address IS NOT NULL) <> (token_out2_address IS NOT NULL))
      );
  END IF;
END$$;

-- ── 8. Confirmed yield legs — ONE constraint, per-role predicates ───────────
--
-- Deliberately a single named constraint (`agent_activity_yield_confirmed_legs`)
-- rather than four siblings: the roles disagree about what "both legs" even
-- means, and splitting them across constraints hides that disagreement from a
-- reader who greps for only one of the names. Each arm is an implication scoped
-- to its own role, so the arms cannot interfere.
--
--   * `yield_pt` / `yield_yt` / `yield_sy` — one in, one out. The ordinary
--     shape; `yield_sy` wraps or unwraps a single instrument and never splits.
--   * `yield_claim`           — an OUTPUT credit and NOTHING more. The role with
--     no input leg: a claim sweeps accrued income, nothing is spent. Requiring
--     an executed input would make the one shape a claim always has UNWRITABLE
--     and push the finalizer toward inventing a value to satisfy the database.
--     A claim that mines but credits nothing decodable must stay `pending` —
--     which this permits and the finalizer enforces.
--   * `yield_py`              — both Option-C legs on the side the action
--     populates: both OUTS on a mint, both INS on a redeem, and neither on the
--     side it does not (constraint 7 already forbids populating both sides).
--   * `yield_lp`              — dual invariants ONLY where the dual columns are
--     populated. Single-token add/remove is the shipped shape (one in, one out);
--     the dual variants populate a second leg, and only then must prove it.
--
-- As the header says: this proves legs are PRESENT, not that they are RIGHT.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_yield_confirmed_legs'
  ) THEN
    ALTER TABLE agent_activity
      ADD CONSTRAINT agent_activity_yield_confirmed_legs
      CHECK (
        status <> 'confirmed'
        OR (
          (
            event_role NOT IN ('yield_pt', 'yield_yt', 'yield_sy')
            OR (executed_amount_in_raw IS NOT NULL AND executed_amount_out_raw IS NOT NULL)
          )
          AND (
            event_role <> 'yield_claim'
            OR (executed_amount_out_raw IS NOT NULL AND executed_amount_in_raw IS NULL)
          )
          AND (
            event_role <> 'yield_py'
            OR (
              executed_amount_in_raw IS NOT NULL
              AND executed_amount_out_raw IS NOT NULL
              AND (token_in2_address IS NULL OR executed_amount_in2_raw IS NOT NULL)
              AND (token_out2_address IS NULL OR executed_amount_out2_raw IS NOT NULL)
            )
          )
          AND (
            event_role <> 'yield_lp'
            OR (
              executed_amount_in_raw IS NOT NULL
              AND executed_amount_out_raw IS NOT NULL
              AND (token_in2_address IS NULL OR executed_amount_in2_raw IS NOT NULL)
              AND (token_out2_address IS NULL OR executed_amount_out2_raw IS NOT NULL)
            )
          )
        )
      );
  END IF;
END$$;
