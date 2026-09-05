-- THE LAUNCHPAD FAMILY VOCABULARY, THE VENUE-INDEPENDENT VEX FEE ROLE, AND THE
-- ONE CONTROLLED AGENTSCAN BACKFILL THAT THE WIDENING OWES.
--
-- Owner decision 2026-09-04 (launchpads arc, plan section 3): the launchpad
-- surface is named by WHAT HAPPENED, not by which venue it happened at, so a
-- second launchpad does not mint a second copy of every role. Five roles arrive
-- together because they are ONE vocabulary decision:
--
--   creator_fee_claim    the launch creator taking their share of the trading
--                        fees their token earned. Two assets - the launched
--                        token and the asset it was paired against - so it
--                        joins the second-OUTPUT-leg allowlist beside
--                        pools_claim.
--   holder_reward_claim  a holder taking their share of a token's reward
--                        stream. Same two-asset shape (token mode, paired mode,
--                        both mode).
--   reward_distribution  the PERMISSIONLESS call that pushes a distributor's
--                        accrued rewards out to every holder. The caller is
--                        paid nothing, so it is not a claim of theirs; it is
--                        deliberately NOT a second-leg role, because a second
--                        leg on it would be evidence the writer decoded the
--                        wrong transaction. Its output amounts stay OPTIONAL:
--                        the distributed total is a real fact about the
--                        transaction and the one amount a distribute has.
--   launch_cancel        the creator ending a launch before it goes live. It
--                        rides the launch kind: same operation, same contract,
--                        terminal move, and the refund it produces is the only
--                        leg it carries.
--   vex_fee              Vex's own integrator fee leg, named by WHO charged it
--                        rather than by where. The four venue-named fee roles
--                        (trench_fee, swap_fee, bridge_fee, pools_fee) stay for
--                        the rows already written under them.
--
-- WHICH KINDS ADMIT vex_fee: swap, bridge and launch, and no others. That is
-- not a preference, it is the mirror of the AgentScan contract this install
-- reports to (`packages/contract/src/role-binding.ts`, server migration
-- `0018_launchpad_family_roles.sql`): the server admits vex_fee on exactly those
-- three arms, so a row written on any other arm could never be reported. The
-- producer's own fourth fee role, `tx_vex_fee` (migration 088), is deliberately
-- NOT folded into vex_fee and NOT sent: it belongs to the `transaction` kind,
-- which the AgentScan contract does not have (plan v3 section 9, "Naming": the
-- server-side `tx_vex_fee` addition was WITHDRAWN). It keeps its own role here.
--
-- SERVER FIRST. The AgentScan server ships this vocabulary BEFORE this
-- migration lands, so an install running new client code against an old server
-- is refused by the ingest contract rather than writing rows the server's table
-- cannot hold. `agents-colab/agents_dm/verify/agentscan-contract-acceptance.ts`
-- pins both halves of that ordering.
--
-- ── COMPATIBILITY AND ROLLBACK ──────────────────────────────────────────────
--
-- Expand-only. No kind is added, no column is dropped, no existing member of any
-- restated CHECK is removed, and every one of the five roles is NEW in this
-- file, so every constraint below validates cleanly against every installed
-- database with no NOT VALID and no backfill.
--
-- OLD CODE ON A NEW DATABASE is safe: a widened CHECK accepts everything the
-- narrower one did, the new `launched_tokens` columns are nullable,
-- `agentscan_reporting_state.vocabulary_version` has a DEFAULT, and so do the
-- two columns added in section 7 (`backfill_vocabulary_version` is nullable,
-- `registration_generation` defaults to 0), so an old build's INSERTs and
-- UPDATEs, which name neither, still succeed. An old build cannot write
-- `backfill_vocabulary_version` at all, which is precisely the property section
-- 7 relies on: its V1-only backfill cannot satisfy the V2 gate. The one
-- behaviour an old build sees is the reset `backfill_enqueued_at` below, which
-- it handles correctly by construction - that is the existing one-time backfill
-- branch of `sync/agentscan-report.ts`, and its enqueue is a diff against the
-- outbox, so it re-sends nothing that has already been sent.
--
-- AMENDED 2026-09-04, BEFORE RELEASE, and every statement below is written to be
-- idempotent on a database where the FIRST version of this file already ran (the
-- development install). The amendment adds two columns to
-- `agentscan_reporting_state` - `backfill_vocabulary_version` and
-- `registration_generation` - with `ADD COLUMN IF NOT EXISTS`, so re-running the
-- file is a no-op on the columns that exist and creates the two that do not. It
-- does NOT re-run the vocabulary walk (still guarded by `vocabulary_version < 2`)
-- and deliberately does NOT backfill `backfill_vocabulary_version` for an install
-- whose backfill was already marked: nothing in the database says which BINARY
-- wrote that mark, so stamping it would assert coverage that may not exist. A
-- NULL stamp simply means "no backfill has proven it covered this vocabulary",
-- and `sync/agentscan-report.ts` treats that as a backfill still owed - the
-- enqueue is a diff, so the repair costs one scan and re-sends nothing.
--
-- ROLLBACK is by restoring the previous constraint bodies (migration 088 for the
-- role list and the kind/role binding, migration 082 for the second-leg
-- allowlist) after deleting any row that carries one of the five new roles;
-- there is no down script in this repository's forward-only migration runner.
-- Reverting the reporting-state column would abandon a backfill that has already
-- been marked, which is harmless: the mark is idempotent and the diff scan never
-- re-enqueues a pair the outbox already holds.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final; `vex-app/scripts/check-build-artifacts.mjs` is the gate.
--
-- Forward-only; idempotent (drop-and-recreate named constraints, ADD COLUMN IF
-- NOT EXISTS, and a guarded one-shot state update).

-- ── 1. The role vocabulary ─────────────────────────────────────────────────
--
-- Every existing member is carried across byte-for-byte from 088 (the current
-- state). A CHECK cannot be amended in place, so a restatement that dropped a
-- member would make those rows unwritable.

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
    'vex_fee'
  ));

-- ── 2. The kind/role binding ───────────────────────────────────────────────
--
-- The CHECK body carries NO inline comments, because the repository's SQL-check
-- evaluator (`__tests__/vex-agent/db/repos/_sql-check-eval.ts`) parses these
-- expressions to answer "would Postgres accept this row?" and has no comment
-- token. The reasoning lives in this header.
--
-- The three claim-family roles join the `claim` arm beside `pools_claim`;
-- `launch_cancel` joins the `launch` arm; `vex_fee` joins swap, bridge and
-- launch and nothing else. The `transaction` arm is untouched.

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
  );

-- ── 3. The second OUTPUT leg the two new claims are defined by ─────────────
--
-- Migration 053 bound the `*_in2_*` / `*_out2_*` columns to `yield_py` and
-- `yield_lp`; migration 082 added `pools_claim` for the two assets a creator-fee
-- claim pays. `creator_fee_claim` and `holder_reward_claim` join on the same
-- terms and for the same reason - a creator claim pays the launched token AND
-- the asset it was paired against, and a holder-reward claim has a paired mode
-- and a both mode that do exactly that - with the INPUT second leg still
-- forbidden, because a claim spends nothing.
--
-- `reward_distribution` is deliberately ABSENT: the caller is paid nothing, so a
-- second leg on it would be evidence of a misread transaction. It falls through
-- to the final arm, which forbids every second-leg column on both sides.
--
-- The predicate is restated in full because a CHECK cannot be extended in place;
-- the `yield_py` / `yield_lp` and `pools_claim` arms are carried across from 082.
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_second_leg_roles_only;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_second_leg_roles_only
  CHECK (
    event_role IN ('yield_py', 'yield_lp')
    OR (
      event_role IN ('pools_claim', 'creator_fee_claim', 'holder_reward_claim')
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

-- ── 4. The claim family spends nothing ─────────────────────────────────────
--
-- Spending nothing is a DURABLE invariant of a claim, not merely how today's
-- writer fills the row, and it is what the AgentScan contract enforces on ingest
-- (`INPUT_LEG_FORBIDDEN_ROLES`). A distribute spends nothing either:
-- `distribute()` moves the distributor's own accrued balance to the holders and
-- takes nothing from the caller but gas, which this ledger does not model as a
-- leg. Writing an input leg on one of these roles would therefore produce a row
-- the server refuses item by item, and the database refuses it first.
--
-- Scoped to the THREE NEW roles only. `pools_claim` and `yield_claim` are
-- deliberately not added: rows already exist under them, and a constraint that
-- can fail on installed data is not an expand-only migration. Both are still
-- held to the same rule on the way out, by the mapper's mirror of the server's
-- `INPUT_LEG_FORBIDDEN_ROLES` (`agentscan/mapper.ts`).
ALTER TABLE agent_activity DROP CONSTRAINT IF EXISTS agent_activity_claim_family_no_input_leg;
ALTER TABLE agent_activity
  ADD CONSTRAINT agent_activity_claim_family_no_input_leg
  CHECK (
    event_role NOT IN ('creator_fee_claim', 'holder_reward_claim', 'reward_distribution')
    OR (
      token_in_address IS NULL AND token_in_symbol IS NULL AND token_in_decimals IS NULL
      AND amount_in_human IS NULL AND amount_in_raw IS NULL
      AND executed_amount_in_human IS NULL AND executed_amount_in_raw IS NULL
    )
  );

-- ── 5. The AgentScan attestation is SUBMITTED, not VERIFIED ────────────────
--
-- `agentscan_attested_at` (migration 074) means "the attestation POST returned
-- 2xx". That is SUBMITTED: the server has accepted the claim into its verify
-- queue and answered `{status:"accepted", verifyStatus:"unverified"}`. Whether
-- the creation proof actually holds is decided later by the server's verify job
-- and is readable at `GET /v1/tokens/:chainId/:address`, whose `status` field
-- carries the server's own vocabulary. Treating acceptance as verification is
-- what plan v3 section 0 recorded as the D4 defect; these columns are the fix.
--
-- `agentscan_verify_status` holds the server's word verbatim, from the closed
-- set `packages/core/src/attestation-precedence.ts` publishes
-- (`AttestationDisplayStatus`). `unverified` is the non-terminal state the read-
-- back sweep keeps polling; `verified`, `mismatch`, `unverifiable` and `revoked`
-- are terminal and the row leaves the poll for good. NULL means the read-back
-- has never run for this row, which is a different fact from "the server says
-- unverified" and is why the column is nullable rather than defaulted.
ALTER TABLE launched_tokens
  ADD COLUMN IF NOT EXISTS agentscan_verify_status       TEXT,
  ADD COLUMN IF NOT EXISTS agentscan_verify_checked_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS agentscan_verified_at         TIMESTAMPTZ;

ALTER TABLE launched_tokens DROP CONSTRAINT IF EXISTS launched_tokens_agentscan_verify_status_valid;
ALTER TABLE launched_tokens
  ADD CONSTRAINT launched_tokens_agentscan_verify_status_valid
  CHECK (
    agentscan_verify_status IS NULL
    OR agentscan_verify_status IN ('unverified', 'verified', 'mismatch', 'unverifiable', 'revoked')
  );

-- The stamp exists exactly when the server said `verified`, so the two can never
-- tell different stories about the same row.
ALTER TABLE launched_tokens DROP CONSTRAINT IF EXISTS launched_tokens_agentscan_verified_stamp;
ALTER TABLE launched_tokens
  ADD CONSTRAINT launched_tokens_agentscan_verified_stamp
  CHECK (
    (agentscan_verify_status = 'verified' AND agentscan_verified_at IS NOT NULL)
    OR (agentscan_verify_status IS NULL AND agentscan_verified_at IS NULL)
    OR (agentscan_verify_status IN ('unverified', 'mismatch', 'unverifiable', 'revoked')
        AND agentscan_verified_at IS NULL)
  );

-- The read-back sweep's hot path: submitted rows whose verdict is still open.
CREATE INDEX IF NOT EXISTS idx_launched_tokens_agentscan_verify_pending
  ON launched_tokens (agentscan_verify_checked_at NULLS FIRST, id)
  WHERE agentscan_attested_at IS NOT NULL
    AND (agentscan_verify_status IS NULL OR agentscan_verify_status = 'unverified');

-- ── 6. The vocabulary version, and the ONE controlled backfill it owes ─────
--
-- WHY A VERSION AND NOT A BOOLEAN. Widening the reportable vocabulary makes
-- rows that ALREADY EXIST newly eligible. The AgentScan outbox is filled by a
-- diff scan (`db/repos/agentscan-reporting.ts`), and that scan runs in two
-- modes: the one-time post-registration BACKFILL (`backfill = TRUE`, "this is
-- history") and the incremental tick (`backfill = FALSE`, "this just
-- happened"). Without a gate, the first incremental tick after this migration
-- would sweep up months of historical claim rows and label every one of them
-- live activity - a lie the server has no way to detect and no way to correct,
-- because a completed outbox row is never re-sent.
--
-- So the widening declares its version, and the eligibility predicate admits the
-- new roles only when this install has run the controlled backfill for it. The
-- shape is the one VS Code uses for a one-time storage migration
-- (`src/vs/workbench/services/extensions/common/extensionStorageMigration.ts`):
-- a DURABLE done-marker, the work skipped entirely when the marker is present,
-- and the marker written after the work, so a crash in between simply re-runs a
-- step that is idempotent by construction.
--
-- Here the marker is the EXISTING `backfill_enqueued_at`, reset to NULL by this
-- statement. The reset is not a resend: `enqueueEligibleActivity` inserts only
-- (activity, status) pairs the outbox has never seen, so already-reported rows
-- are untouched and only the newly-eligible ones are enqueued, correctly flagged
-- as history.
--
-- The guard makes the statement idempotent across a re-run of the file: an
-- install already at version 2 has had its backfill scheduled once and must not
-- have it scheduled again.
--
-- THE THREE STEPS ARE ORDERED, AND THE ORDER IS THE POINT. The singleton row is
-- created LAZILY by `ensureSingleton()`, not by the migration that created the
-- table, so on a fresh install the UPDATE below matches nothing. Adding the
-- column at DEFAULT 1 and only then moving the default to 2 is what makes both
-- populations right: an EXISTING row is walked from 1 to 2 together with the
-- backfill reset it owes, while a row this install has not created yet is born
-- at 2, on a schema that already carries the widened vocabulary, and reaches the
-- new roles through the ordinary first-registration backfill. A column added
-- straight at DEFAULT 2 would silently skip the reset for every existing
-- install; a column left at DEFAULT 1 would make every future install blind to
-- the new roles forever.
ALTER TABLE agentscan_reporting_state
  ADD COLUMN IF NOT EXISTS vocabulary_version INTEGER NOT NULL DEFAULT 1;

UPDATE agentscan_reporting_state
   SET vocabulary_version = 2,
       backfill_enqueued_at = NULL,
       updated_at = NOW()
 WHERE id = 1
   AND vocabulary_version < 2;

ALTER TABLE agentscan_reporting_state
  ALTER COLUMN vocabulary_version SET DEFAULT 2;

-- ── 7. WHICH vocabulary a backfill actually covered, and WHICH registration it
--       belonged to ──────────────────────────────────────────────────────────
--
-- `vocabulary_version` above says what the SCHEMA can store. It is not, and was
-- mistakenly read as, a statement about what a completed backfill SCANNED, and
-- the difference is a real defect during a staged rollout: a binary whose
-- `AGENTSCAN_VOCABULARY_VERSION` is 1, running against a database this migration
-- has already stamped at 2, performs a V1-only scan and writes
-- `backfill_enqueued_at`. A later V2 binary reads that timestamp as "the family
-- history is covered", and every historical claim, launch_cancel and vex_fee row
-- then reaches the server through the INCREMENTAL tick, labelled live activity -
-- a lie the server cannot detect and this install cannot correct, because a
-- completed outbox row is never re-sent.
--
-- So the completion marker gains the version it covered. NULLABLE with no
-- default, on purpose: an old binary does not know the column, cannot write it,
-- and therefore cannot satisfy the gate. `db/repos/agentscan-reporting.ts`
-- compares `backfill_vocabulary_version >= AGENTSCAN_VOCABULARY_VERSION` instead
-- of testing the timestamp for NULL, and the marking transaction stamps it with
-- the version that scan ran under, never with the schema's.
--
-- `registration_generation` is the fence for the OTHER half of the same
-- marker. `resetForReRegistration` (the 401 recovery) clears the completion mark
-- because the whole history is owed again. The backfill's enqueue and its mark
-- used to be two commits, so a reset landing between them was overwritten by the
-- stale mark that had started before it. Every reset now bumps this counter, and
-- the backfill carries the generation it started under into its marking
-- statement, which refuses to write when the generation has moved. NOT NULL
-- DEFAULT 0 because a monotonically increasing counter has a correct starting
-- value; the two writers that bump it are the two reset paths and nothing else.
ALTER TABLE agentscan_reporting_state
  ADD COLUMN IF NOT EXISTS backfill_vocabulary_version INTEGER,
  ADD COLUMN IF NOT EXISTS registration_generation     INTEGER NOT NULL DEFAULT 0;
