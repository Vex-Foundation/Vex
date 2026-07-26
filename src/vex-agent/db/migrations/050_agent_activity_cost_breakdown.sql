-- Agent Scan — honest cost breakdown + the `bridge_fee` event role.
--
-- Three changes that share one motive: `agent_activity` could not state what a
-- transaction actually cost, could not state the fee Vex itself charged, and
-- could not tell "Vex charged nothing" apart from "nobody wrote it down".
--
-- ── Part 1: `usd_fee_est` held two different things and never the Vex fee ────
--
-- One NUMERIC column named for "the fee" was written by three writers with
-- three different meanings, distinguishable only by `usd_source`:
--
--   * kyberswap swap leg     → `buildResp.data.gasUsd` — NETWORK GAS, and
--     (`usd_source='kyberswap_quote'`)  L2-EXECUTION ONLY: it excluded
--                                `l1FeeUsd`, which on the OP-stack chains that
--                                make up most of the supported set can rival or
--                                exceed `gasUsd` (see the same note in
--                                `tools/protocols/kyberswap/helpers.ts`);
--   * jupiter prediction     → `order.estimatedTotalFeeUsd` — the PROVIDER's
--     (`usd_source=              protocol+venue fee, excluding Solana network
--      'jupiter_prediction_       transaction fees. Not gas at all;
--       order_preview'`)
--   * khalani / relay bridge → NULL (never written).
--
-- And Vex's OWN integrator fee — 25 bps on KyberSwap (`routeSummary.extraFee`,
-- parsed and projected to the tool output), 25 bps on Jupiter swaps, 25 bps on
-- bridges (`src/tools/bridge-fee`) — was persisted NOWHERE. No `SUM()` over
-- `usd_fee_est` exists anywhere in the tree, so this was latent rather than a
-- live miscount; this migration fixes it before a revenue report is built on a
-- column that means two things.
--
-- Four nullable NUMERICs replace the single mixed meaning:
--
--   usd_network_gas_est        gas only — NOT part of tx.value
--   usd_venue_fee_est          venue/protocol fee (Jupiter's total, Kyber's extraFee)
--   usd_destination_prepay_est destination execution prepay
--   usd_vex_fee_est            the Vex integrator fee
--
-- EXPAND-AND-CONTRACT, and this file is the EXPAND half only:
--   1. add the four columns (all nullable — every existing row is valid);
--   2. the writers dual-write (`usd_fee_est` keeps its EXACT historical value
--      and meaning for the whole window — see the freeze note below);
--   3. backfill, SOURCE-SCOPED (below);
--   4. `usd_fee_est` is DROPPED IN A LATER MIGRATION, deliberately not here.
--      Prerequisites for that contract step are listed at the end of this file.
--
-- BACKFILL IS NEVER BLIND. The same column means a different thing per source,
-- so each historical value moves to the column that matches ITS OWN source and
-- nowhere else. A row with any other `usd_source` (or none) keeps `usd_fee_est`
-- and gains no new value — inventing a classification for it would be exactly
-- the mixed-meaning bug this migration exists to end.
--
-- `usd_fee_est` FREEZE (deliberate, and the one place the two columns can
-- disagree): the Kyber writer now records `gasUsd + l1FeeUsd` in
-- `usd_network_gas_est` — the honest total — while `usd_fee_est` keeps
-- receiving `gasUsd` alone, byte-identical to its pre-migration behavior. Old
-- code reading `usd_fee_est` during the dual-write window therefore sees
-- exactly what it saw before, which is the whole point of the window. The
-- consequence to know when reading the data: on an OP-stack row
-- `usd_network_gas_est > usd_fee_est` is CORRECT, not drift. Historical
-- backfilled rows carry L2-only gas in `usd_network_gas_est` because the L1
-- component was never recorded and is not recoverable — that gap is permanent
-- and is why the column is `_est`.
--
-- ── Part 2: the Vex fee as a FACT, not only as a USD estimate ───────────────
--
-- `usd_vex_fee_est` above is an ESTIMATE and is nullable, so `NULL` there means
-- "the USD is not known" — it has never meant "no fee was charged". Nothing in
-- the row let a reader tell those apart, and the agent reads VALUES, not this
-- comment. The worst case is not hypothetical: a Jupiter swap charges 25 bps
-- and NO USD price is fetched anywhere on that path, so its `usd_vex_fee_est`
-- is NULL on every single row, forever, and reads as "Vex charged nothing".
--
-- If the USD is genuinely unknown, then record what IS known: the token the fee
-- was taken in and the exact amount taken. That is available on every venue,
-- always, with no extra provider call and no price lookup.
--
-- Five nullable columns, typed and named after the `token_in_*` / `amount_in_*`
-- family they mirror, so the pattern is recognisable at a glance:
--
--   vex_fee_token_address    TEXT      the token the fee was taken IN
--   vex_fee_token_symbol     TEXT      display only
--   vex_fee_token_decimals   SMALLINT  REQUIRED to read the raw amount
--   vex_fee_amount_raw       TEXT      atomic units, digit-exact
--   vex_fee_amount_human     TEXT      exact-decimal sibling of the raw amount
--
-- `vex_fee_amount_raw` is TEXT, never NUMERIC, for the same reason
-- `amount_in_raw` is: a u64/u128 atomic amount exceeds `MAX_SAFE_INTEGER` and
-- must survive as digits. Decimals travel WITH the amount because `"25000"`
-- beside a bare token address is 0.025 at 6 decimals and 0.000025 at 9.
--
-- WHERE THE VALUE COMES FROM, per venue — exact, never a re-derived guess:
--
--   * KyberSwap swap leg. NOT from `routeSummary.extraFee.feeAmount`: Vex always
--     sends `isInBps=true` (`constants.ts`), so the provider echoes the STRING
--     "25" — the bps rate, not an amount. Persisting that echo would have
--     recorded 25 atomic units instead of 25 bps of the trade. The exact amount
--     is the one the ROUTER itself computes, `floor(amount * 25 / 10000)` on the
--     source token, and every input to it is asserted by
--     `tools/kyberswap/evm/swap-calldata-guard.ts` BEFORE signing: `desc.amount`
--     equals the approved `amountIn`, `desc.feeAmounts == [25]`, `_FEE_IN_BPS`
--     set, `_FEE_ON_DST` clear, partial fill forbidden. Confirmed against real
--     captured calldata (`fixtures/route-build/`): `desc.amount` 10000000 minus
--     `sum(desc.srcAmounts)` 9975000 is exactly 25000. Owned by
--     `tools/kyberswap/swap-vex-fee.ts`.
--   * Jupiter swap. `feeAmountRaw` / `feeAmountDecimal` on the input mint,
--     already computed in exact bigint floor division by
--     `jupiter-swaps/fee-swap.ts` and already disclosed at approval.
--   * Bridges get NO new columns and need none. The Vex bridge fee is its OWN
--     transfer and therefore its own row (`event_role = 'bridge_fee'`, Part 3),
--     whose `token_in_*` / `amount_in_*` ALREADY record the exact token and the
--     exact amount transferred. Duplicating them into `vex_fee_*` would store
--     the same money twice and invite a double count.
--
-- HOW TO READ IT — the null-pair rule these columns exist to make true:
--
--   vex_fee_amount_raw NOT NULL, usd_vex_fee_est NULL  → fee charged, USD unknown
--   vex_fee_amount_raw NOT NULL, usd_vex_fee_est NOT NULL → fee charged, USD estimated
--   BOTH NULL, event_role <> 'bridge_fee'              → NO Vex fee on this row
--   event_role = 'bridge_fee'                          → the fee IS this row:
--                                                        read `amount_in_*`
--
-- Exactly three code paths charge a Vex fee (`BRIDGE_FEE_BPS`,
-- `KYBERSWAP_FEE_BPS`, `JUPITER_SWAP_FEE_BPS` — all 25). Every other writer
-- (lend, borrow, predictions, allowance legs, pre-broadcast failures) charges
-- nothing, which is why "both NULL" is now a positive statement rather than an
-- absence of information.
--
-- DO NOT ADD `vex_fee_amount_raw` TO `amount_in_raw`. On the two in-transaction
-- venues the fee is taken FROM the input, so it is a COMPONENT of
-- `amount_in_raw`, not an extra debit beside it (Kyber: the router keeps 25 bps
-- of `desc.amount` and swaps the remaining 9975000 of 10000000). A bridge fee is
-- the opposite — a separate transfer on its own row, on top of the deposit.
--
-- NO BACKFILL, deliberately, and the one thing a reader of OLD rows must know.
-- The fee amount was never recorded before this migration and is not honestly
-- recoverable: a historical row does not prove what its calldata charged, and
-- asserting "25 bps of `amount_in_raw`" across every past KyberSwap row would be
-- precisely the blind backfill Part 1 refuses to perform. So on a row created
-- BEFORE 050, `vex_fee_amount_raw IS NULL` means "not recorded", NOT "no fee".
-- The null-pair rule above holds for every row written by the CURRENT writers.
--
-- ── Part 3: `bridge_fee` — a fee collection recorded as an approval ─────────
--
-- The Vex bridge fee transfer (`src/tools/bridge-fee`, wired in
-- `tools/khalani/bridge-executor.ts` and `protocols/relay/handlers/bridge.ts`)
-- was recorded under `event_role = 'allowance'`. That was a REASONED choice,
-- not an oversight: `bridge_deposit` is disqualified because
-- `sync/bridge-activity-repair-production-deps.ts` correlates the provider
-- order by selecting the sibling row with `event_role = 'bridge_deposit'`, so a
-- second such row would hand the repair sweep the FEE hash as the deposit hash;
-- `bridge_fill_observed`/`bridge_refund` are destination-side externally-
-- observed evidence, which this leg is not. `allowance` was the only remaining
-- safe bucket.
--
-- It is still untrue in the durable record — a fee collection is not an
-- approval, and the agent reads this record back. `bridge_fee` is added to the
-- two closed vocabularies that govern `event_role`, and NOTHING else about the
-- leg changes: it stays the FINAL Vex-signed origin leg (after the deposit, so
-- a bridge that never lands never pays a fee), locally signed, staged through
-- the same CAS primitives, and reapable by the same hashless-recovery sweep
-- (`db/repos/agent-activity/hashless-recovery.ts` adds it to
-- `LOCALLY_SIGNABLE_ACTIVITY_ROLES` in the same change — a never-signed fee row
-- must stay reapable exactly as `allowance` was).
--
-- Only TWO CHECK constraints reference `event_role` as a vocabulary and so need
-- widening (`agent_activity_event_role_valid`, `agent_activity_kind_role_
-- binding`). The other four that mention the column are ROLE-SCOPED predicates
-- already satisfied by a `bridge_fee` row, verified rather than assumed:
--   * `agent_activity_confirmed_swap_has_executed_legs` (044) — scoped
--     `event_role <> 'swap'`, so a confirmed fee leg needs no executed legs;
--   * `agent_activity_normalized_route_logical_only` (045) — biconditional on
--     `bridge_fill_expected`; a fee row carries `normalized_route IS NULL`;
--   * `agent_activity_logical_has_session` (045) — scoped to the logical row;
--   * `agent_activity_order_id_logical_only` (045) — a fee row carries no
--     `provider_order_id`.
-- The 045 route/family invariants hold unchanged: `insertBridgeRow` stamps the
-- route endpoints on EVERY bridge row (`agent_activity_bridge_has_route`), and
-- 049's `agent_activity_kind_family_binding` constrains only lend/prediction.
--
-- No approval gate, failure code, or trust boundary changes here.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

-- ── 1. Cost columns (all nullable; every existing row is already valid) ──────

ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS usd_network_gas_est        NUMERIC;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS usd_venue_fee_est          NUMERIC;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS usd_destination_prepay_est NUMERIC;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS usd_vex_fee_est            NUMERIC;

-- ── 2. The Vex fee in TOKEN units — the fact behind the estimate (Part 2) ────
--
-- Types mirror `token_in_*` / `amount_in_raw` exactly (044): TEXT identity, TEXT
-- raw amount so u64/u128 digits survive, SMALLINT decimals. NEVER NUMERIC for
-- the raw amount. Populated only by a writer that actually charges a fee IN the
-- transaction; a bridge fee is its own `bridge_fee` row and stays out of here.

ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS vex_fee_token_address  TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS vex_fee_token_symbol   TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS vex_fee_token_decimals SMALLINT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS vex_fee_amount_raw     TEXT;
ALTER TABLE agent_activity ADD COLUMN IF NOT EXISTS vex_fee_amount_human   TEXT;

-- ── 3. Source-scoped backfill (USD only — see Part 2 on why the token
--       amount is deliberately NOT backfilled) ──────────────────────────────
--
-- The `IS NULL` guard on the TARGET makes each statement a no-op on re-run and
-- — more importantly — means a value already written by the new dual-writing
-- code is never overwritten by the historical one.

UPDATE agent_activity
   SET usd_network_gas_est = usd_fee_est
 WHERE usd_source = 'kyberswap_quote'
   AND usd_fee_est IS NOT NULL
   AND usd_network_gas_est IS NULL;

UPDATE agent_activity
   SET usd_venue_fee_est = usd_fee_est
 WHERE usd_source = 'jupiter_prediction_order_preview'
   AND usd_fee_est IS NOT NULL
   AND usd_venue_fee_est IS NULL;

-- ── 4. `bridge_fee` event role (drop + re-add named, 034/035/045/049 pattern) ─

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
        'predict_buy', 'predict_sell', 'predict_claim', 'predict_close'
      ));
  END IF;
END$$;

-- `bridge_fee` joins the BRIDGE arm only — a swap/lend/prediction row can never
-- carry it, exactly as the other bridge roles cannot.
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
      );
  END IF;
END$$;

-- ── 5. What the LATER contract migration that drops `usd_fee_est` still needs ─
--
--   * every writer emitting only the four new columns (the dual-write of
--     `usd_fee_est` removed from `kyberswap/handlers/swap.ts` and
--     `solana-jupiter/predict-execute*.ts`);
--   * `usd_fee_est` removed from the repo layer: `agent-activity/types.ts`,
--     `agent-activity/mappers.ts`, the INSERT column lists in
--     `agent-activity/swap-intent.ts` and `agent-activity/bridge-intent.ts`,
--     and `transactions-types.ts`/`transactions-mappers.ts`;
--   * the `usd_fee_est` projection removed from all THREE union halves of
--     `transactions-query-builder.ts` (the activity half plus the two
--     `NULL::numeric AS usd_fee_est` padding rows that keep the UNION ALL
--     column count aligned — dropping one without the others breaks the feed);
--   * a decision on historical rows whose `usd_source` matched neither backfill
--     branch: their `usd_fee_est` has no honest destination column and is LOST
--     when the column is dropped. Enumerate them first
--     (`SELECT usd_source, count(*) FROM agent_activity WHERE usd_fee_est IS
--     NOT NULL AND usd_source NOT IN ('kyberswap_quote',
--     'jupiter_prediction_order_preview') GROUP BY 1`) and get an owner
--     decision rather than dropping silently.
