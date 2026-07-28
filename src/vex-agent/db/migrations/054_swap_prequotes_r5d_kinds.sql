-- R5d (Pendle SY wrap, dual LP legs, rollover, transfer, LP→PT) — expand
-- swap_prequotes.kind for the seven new Pendle prequote kinds.
--
-- Migration 035 widened `kind` to the PY + LP set ('mint', 'redeem_py',
-- 'lp_add', 'lp_remove'). R5d's write surface adds seven identities that are
-- NEITHER a swap, a bridge, nor any of those: each carries its own material (see
-- prequote/identity/hash.ts) and its own record/gate branch, so none of them may
-- reuse an existing kind.
--
-- WHY EACH IS ITS OWN KIND, and not a reuse. `kind` is not a label: it is a
-- predicate in BOTH gate reads (`findLatestFreshByMatch` and
-- `existsFreshFailByMatch` in db/repos/swap-prequotes.ts). Two actions sharing a
-- kind can authorize each other whenever their material happens to agree, and an
-- action sharing `swap` can be authorized by an ordinary DEX quote. The SY pair
-- shipped exactly that way — `handlers/sy-prequote.ts` stored both directions
-- under 'swap', its own comment conceding "no migration" — so a wrap quote and
-- an unwrap execute were separated only by their token legs, and nothing but the
-- venue label separated either from a real swap. This migration is what lets
-- that be fixed.
--
-- This EXPAND-ONLY migration widens the CHECK to include the seven new kinds:
--   - 'sy_mint'        : Pendle sy.mint    (token → SY),
--   - 'sy_redeem'      : Pendle sy.redeem  (SY → token),
--   - 'lp_remove_dual' : remove-liquidity-dual   (LP → token + PT),
--   - 'lp_add_keep_yt' : add-liquidity keep-YT   (token → LP + YT),
--   - 'pt_rollover'    : roll-over-pt            (PT market A → PT market B),
--   - 'lp_transfer'    : transfer-liquidity      (LP market A → LP market B),
--   - 'lp_to_pt'       : convert-lp-to-pt        (LP → PT).
-- No rows change and no column is dropped.
--
-- EXISTING SY ROWS ARE NOT BACKFILLED, deliberately. A live 'swap'-kind SY row
-- is a prequote for a DIFFERENT digest (its material carried the swap kind tag),
-- so rewriting its `kind` would not make it match the new identity — it would
-- only move a stale row under a name the new gate reads. They expire on their
-- own within PREQUOTE_MAX_AGE_MS; until then an SY execute simply finds no fresh
-- prequote and blocks, which is the fail-closed direction.
--
-- Forward-only, idempotent: drop the old constraint if present, then add the
-- widened one only when it is not already there. The mirror under vex-app is kept
-- in sync by scripts/copy-migrations.mjs.

ALTER TABLE swap_prequotes
  DROP CONSTRAINT IF EXISTS swap_prequotes_kind_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'swap_prequotes_kind_check'
  ) THEN
    ALTER TABLE swap_prequotes
      ADD CONSTRAINT swap_prequotes_kind_check
      CHECK (kind IN ('swap', 'bridge', 'redeem', 'mint', 'redeem_py', 'lp_add', 'lp_remove', 'sy_mint', 'sy_redeem', 'lp_remove_dual', 'lp_add_keep_yt', 'pt_rollover', 'lp_transfer', 'lp_to_pt'));
  END IF;
END$$;
