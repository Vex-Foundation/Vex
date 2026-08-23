-- 087 - pools.fun creator ATTRIBUTION state for a launched token (the VEX badge).
--
-- RUNS AFTER 084. The number is deliberate: a concurrent studio branch claims
-- 085/086 and lands before this one. The runner applies every file whose
-- version exceeds MAX(schema_version), so a gap is harmless but a RENUMBER
-- would not be - an installation that already recorded 085/086 would silently
-- skip a file re-labelled below its own high-water mark. Do not renumber.
--
-- ── Why a DEDICATED signature column, and not 071's ────────────────────────
--
-- Migration 071 stores `attest_signature`: the creator wallet's `personal_sign`
-- over the TRENCH-formatted message. pools.fun asks the creator to sign a
-- DIFFERENT message, so the two are not interchangeable proofs - posting the
-- trench-formatted signature to pools.fun would be refused, and posting the
-- pools-formatted one to trench.express likewise. Reusing one column would put
-- two incompatible proofs behind one name and make "which message was signed?"
-- unanswerable from the row. `pools_attest_signature` is therefore its own
-- column, exactly as 074 gave the AgentScan lane its own delivery state.
--
-- Signable ONLY at launch time, for the identical reason 071 documents: the
-- token address does not exist before the receipt, and nothing after the launch
-- handler holds a signer (the identity-repair sweep deliberately has none). A
-- row without it can never be attributed by the sweep, which is why the sweep
-- COUNTS and NAMES that gap instead of silently skipping it.
--
-- ── The five columns, one fact each ────────────────────────────────────────
--
--   pools_attest_signature          - the creator's signature over the
--                                     pools.fun attestation message. Write-once
--                                     at the repo boundary.
--   pools_attribution_attempted_at  - when the last POST was made. NULL means
--                                     never tried. Stamped on EVERY attempt,
--                                     successful or not, so a permanently
--                                     refused row moves to the back of the
--                                     queue instead of starving row 26 - the
--                                     starvation `sweep-claim.ts` documents.
--   pools_attributed_at             - pools.fun CONFIRMED the badge. Terminal.
--   pools_attribution_rejected_at   - pools.fun DEFINITIVELY refused. Terminal.
--                                     A refusal is NOT a transport failure: a
--                                     transport failure leaves both terminal
--                                     columns NULL and the row is retried.
--   pools_attribution_rejection_code- WHY it was refused, from a frozen
--                                     vocabulary (below).
--
-- Two terminal columns rather than one, because "the badge landed" and "the
-- badge will never land" are different facts and collapsing them would make a
-- refused row indistinguishable from an attributed one in every read.
--
-- Expand-only: nullable, no default, no backfill. Every launch that happened
-- before this migration reads as "never attempted, no signature" - the honest
-- state. Rollback is clean while the columns carry no data.
--
-- Mirror: run `node vex-app/scripts/copy-migrations.mjs` after this file is
-- final.

ALTER TABLE launched_tokens
  ADD COLUMN IF NOT EXISTS pools_attest_signature           TEXT,
  ADD COLUMN IF NOT EXISTS pools_attribution_attempted_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pools_attributed_at              TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pools_attribution_rejected_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pools_attribution_rejection_code TEXT;

COMMENT ON COLUMN launched_tokens.pools_attest_signature IS
  'Creator signature over the POOLS.FUN attestation message. Not interchangeable with attest_signature (071), which signs the trench-formatted message. Write-once.';
COMMENT ON COLUMN launched_tokens.pools_attribution_attempted_at IS
  'Last pools.fun attribution POST attempt (any outcome). NULL = never tried.';
COMMENT ON COLUMN launched_tokens.pools_attributed_at IS
  'pools.fun confirmed the badge. Terminal - the row leaves the sweep''s candidate set for good.';
COMMENT ON COLUMN launched_tokens.pools_attribution_rejected_at IS
  'pools.fun definitively refused the badge. Terminal. A transport failure is NOT a rejection and leaves this NULL.';
COMMENT ON COLUMN launched_tokens.pools_attribution_rejection_code IS
  'Why the attribution was definitively refused. Frozen vocabulary, mirrored by src/tools/pools-fun/attribution-codes.ts.';

-- ── Schema invariants ──────────────────────────────────────────────────────
--
-- The repo functions make these states unrepresentable through CAS predicates.
-- These CHECKs exist to OUTLIVE the repo: a future writer, a later migration,
-- or a manual intervention would otherwise be able to write a row the readers
-- cannot interpret. Each is dropped-and-added rather than edited, because a
-- CHECK cannot be amended in place.

-- A rejection and its reason are ONE fact. A rejected row with no code cannot
-- be explained to the user or to an operator; a code with no timestamp claims a
-- refusal that never happened.
ALTER TABLE launched_tokens DROP CONSTRAINT IF EXISTS launched_tokens_pools_rejection_has_code;
ALTER TABLE launched_tokens
  ADD CONSTRAINT launched_tokens_pools_rejection_has_code
  CHECK ((pools_attribution_rejected_at IS NULL) = (pools_attribution_rejection_code IS NULL));

-- The two terminal states are MUTUALLY EXCLUSIVE. A row that is both attributed
-- and refused has no answer to "did the badge land?", and both terminal writers
-- CAS on both columns precisely so this cannot arise from the repo.
ALTER TABLE launched_tokens DROP CONSTRAINT IF EXISTS launched_tokens_pools_one_terminal_state;
ALTER TABLE launched_tokens
  ADD CONSTRAINT launched_tokens_pools_one_terminal_state
  CHECK (NOT (pools_attributed_at IS NOT NULL AND pools_attribution_rejected_at IS NOT NULL));

-- FROZEN VOCABULARY. `src/tools/pools-fun/attribution-codes.ts` carries the same
-- three literals and a lockstep test asserts this CHECK against it, so the two
-- cannot drift. Widening the vocabulary means a new migration restating this
-- list in full plus the module plus the lockstep test, in one change.
--
--   invalid_signature  - the recovered signer is not the launch's
--                        GatewayLaunch.launcher.
--   validation_failed  - the request itself was malformed (address, signature
--                        or field shape). May indicate a Vex-side encoding
--                        defect; re-queueing such rows is a deliberate
--                        maintenance action (clearing the rejection stamp),
--                        never automatic.
--   not_pools_launch   - a FINALIZED receipt proves the pinned gateway/factory
--                        relationship absent or mismatched. Never returned for
--                        indexing or finality lag (that is launch_not_ready,
--                        which is retryable).
ALTER TABLE launched_tokens DROP CONSTRAINT IF EXISTS launched_tokens_pools_rejection_code_valid;
ALTER TABLE launched_tokens
  ADD CONSTRAINT launched_tokens_pools_rejection_code_valid
  CHECK (
    pools_attribution_rejection_code IS NULL
    OR pools_attribution_rejection_code IN ('invalid_signature', 'validation_failed', 'not_pools_launch')
  );

-- A TERMINAL STATE REQUIRES THE PROOF THAT PRODUCED IT. Neither outcome is
-- reachable without a POST, and a POST cannot be made without a signature - so a
-- terminal row with no signature is evidence the state was written by something
-- other than the sweep. Keeping it a database fact also keeps the unsigned-gap
-- count honest: an unsigned row is ALWAYS non-terminal, so counting unsigned
-- rows can never quietly include rows that already reached an end state.
ALTER TABLE launched_tokens DROP CONSTRAINT IF EXISTS launched_tokens_pools_terminal_requires_signature;
ALTER TABLE launched_tokens
  ADD CONSTRAINT launched_tokens_pools_terminal_requires_signature
  CHECK (
    (pools_attributed_at IS NULL AND pools_attribution_rejected_at IS NULL)
    OR pools_attest_signature IS NOT NULL
  );

-- ── The sweep's candidate set, and nothing else ────────────────────────────
--
-- Signed, not yet attributed, not yet refused, and a pools.fun launch. Rows
-- leave the index permanently once they reach either terminal state, so it
-- stays small no matter how many tokens accumulate. `launchpad` is IN the
-- predicate because pools.fun and trench.express share chain 4663: a chain-only
-- index would serve trench rows to the pools sweep.
CREATE INDEX IF NOT EXISTS idx_launched_tokens_pending_pools_attribution
  ON launched_tokens (pools_attribution_attempted_at NULLS FIRST)
  WHERE pools_attributed_at IS NULL
    AND pools_attribution_rejected_at IS NULL
    AND pools_attest_signature IS NOT NULL
    AND launchpad = 'pools_fun';
